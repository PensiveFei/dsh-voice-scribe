// SPDX-License-Identifier: MIT
// ============================================================================
// dsh-voice-scribe — host-side LOCAL offline ASR (SenseVoice via sherpa-onnx).
//
// Zero-config & zero-key: the model (~230 MB int8) is downloaded automatically
// on first use from China-reachable mirrors, then recognition runs entirely
// on this machine — no browser speech service, no cloud API, immune to Edge
// regressions / blocked Google / offline networks.
//
// Pipeline: browser decodes its recording to 16 kHz mono float32 PCM and posts
// the raw little-endian bytes (base64). This module feeds sherpa-onnx
// directly — no WAV container, no ffmpeg, no re-encode on the host.
// ============================================================================

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { stat, mkdir, rename, unlink, readdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { once } from "node:events";

const require = createRequire(import.meta.url);

/** sherpa-onnx wants 16 kHz mono. */
export const TARGET_SAMPLE_RATE = 16000;

/** Default model dir: $DSH_HOME/voice/sensevoice, fallback ~/.dsh/voice/sensevoice. */
export function modelDir() {
	const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
	return join(home, "voice", "sensevoice");
}

export function modelFiles(dir = modelDir()) {
	return {
		model: join(dir, "model.int8.onnx"),
		tokens: join(dir, "tokens.txt")
	};
}

/** Plausibility floors. The real int8 model is ~228 MB and tokens.txt ~300 KB;
 *  a download that ends early still leaves a non-empty file, and a published
 *  truncated model is never re-downloaded (startModelDownload skips non-empty
 *  files), so "size > 0" alone let a broken model look ready forever. */
/**
 * Floors must sit near the REAL artifact size (~228 MB model, ~300 KB
 * tokens). They are the backstop for truncation that Content-Length cannot
 * catch (chunked proxy, dropped connection), and an existing file is only
 * refetched when it falls BELOW its floor — so a floor far under the real
 * size let a large truncated stub survive forever.
 */
export const MIN_MODEL_BYTES = 150 * 1024 * 1024;
export const MIN_TOKENS_BYTES = 4096;

export async function modelReady(dir = modelDir(), minModelBytes = MIN_MODEL_BYTES, minTokensBytes = MIN_TOKENS_BYTES) {
	const { model, tokens } = modelFiles(dir);
	try {
		const [ms, ts] = await Promise.all([stat(model), stat(tokens)]);
		return ms.size >= minModelBytes && ts.size >= minTokensBytes;
	} catch {
		return false;
	}
}

// ── model download (mirrors, progress, atomic) ─────────────────────────────

const MODEL_BASE = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";
/** File-based mirrors (model.int8.onnx + tokens.txt). hf-mirror.com is the
 *  China-friendly HF mirror and is verified reachable on mainland networks. */
const MODEL_MIRRORS = [
	"https://hf-mirror.com/" + MODEL_BASE + "/resolve/main",
	"https://huggingface.co/" + MODEL_BASE + "/resolve/main"
];

/** Synchronous claim so concurrent callers cannot both start a download. */
let downloadClaimed = false;
/** Download state, exposed via /voice-input/local-status. */
const downloadState = {
	running: false,
	error: "",
	progress: { file: "", done: 0, total: 0 }
};

export function getDownloadState() {
	return { ...downloadState, progress: { ...downloadState.progress } };
}

/**
 * Is a model file present AND plausibly complete?
 * "Non-empty" is NOT good enough: a download that died early still leaves a
 * stub, and because the retry loop skipped every non-empty file, that stub
 * became permanent — modelReady() then answered false forever while each
 * retry kept on skipping the very file that needed refetching, and the user
 * saw an endless "downloading" that never produced a working model.
 */
async function fileBigEnough(path, minBytes) {
	try {
		return (await stat(path)).size >= minBytes;
	} catch {
		return false;
	}
}

/**
 * Download one file through the mirror list; the first mirror that answers
 * wins. Streams to <target>.part and renames on success (atomic-ish; a
 * partial download never masquerades as ready).
 */
async function downloadFile(mirrors, filename, targetDir, onProgress) {
	const target = join(targetDir, filename);
	const part = join(targetDir, filename + ".part");
	const errors = [];
	for (const mirror of mirrors) {
		const url = mirror + "/" + filename;
		/** @type {import("node:fs").WriteStream | null} */
		let file = null;
		/** @type {ReadableStreamDefaultReader<Uint8Array> | null} */
		let reader = null;
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(600_000) });
			if (!res.ok) throw new Error("HTTP " + res.status);
			const total = Number(res.headers.get("content-length")) || 0;
			reader = res.body.getReader();
			file = createWriteStream(part);
			// A stream "error" emitted with NO listener attached (ENOSPC on a
			// 230 MB download, antivirus file lock, EPERM) is an UNCAUGHT
			// exception that kills the whole host process — the mirror-failover
			// catch below would never run. Keep a listener attached for the
			// stream's entire life and surface it as a normal rejection.
			let writeError = null;
			const writeFailed = new Promise((_, reject) => {
				file.once("error", (err) => {
					writeError = err;
					reject(err);
				});
			});
			// Consumed by the races below; this keeps the standalone promise from
			// being reported as an unhandled rejection when the loop exits first.
			writeFailed.catch(() => {});
			let done = 0;
			for (;;) {
				const { done: isDone, value } = await Promise.race([reader.read(), writeFailed]);
				if (isDone) break;
				if (value && value.byteLength > 0) {
					done += value.byteLength;
					// Honour backpressure: without awaiting drain, a fast mirror
					// on a slow disk buffers the whole 230 MB model in memory.
					if (!file.write(Buffer.from(value))) await Promise.race([once(file, "drain"), writeFailed]);
					onProgress(filename, done, total);
				}
			}
			await Promise.race([
				new Promise((resolve, reject) => file.end((err) => (err ? reject(err) : resolve()))),
				writeFailed
			]);
			if (writeError) throw writeError;
			file = null;
			// A connection dropped mid-transfer ends the read loop WITHOUT an error, so
			// the truncated .part used to be renamed into place — and because
			// startModelDownload skips any non-empty file, that broken model became
			// permanent (the native recognizer then failed with an opaque error).
			if (total > 0 && done !== total) {
				throw new Error("truncated download (" + done + "/" + total + " bytes)");
			}
			await rename(part, target);
			onProgress(filename, done, done);
			return { ok: true, bytes: done };
		} catch (error) {
			errors.push(mirror + ": " + (error && error.message ? error.message : String(error)));
			// Abandoning a response body without cancelling it leaves the mirror
			// streaming the remaining ~230 MB into a socket nobody reads, while the
			// next mirror already starts a second download on top of it.
			if (reader !== null) await reader.cancel().catch(() => {});
			if (file !== null) file.destroy();
			// Delete the partial outright. The old rename-to-.part.fail left up
			// to 230 MB of junk behind on every mirror fallback, forever.
			await unlink(part).catch(() => {});
		}
	}
	return { ok: false, errors };
}

/**
 * Remove stale <name>.part / <name>.part.fail leftovers from interrupted or
 * pre-fix downloads so they never pile up in the model dir.
 */
export async function cleanStaleParts(dir = modelDir()) {
	let removed = 0;
	let entries = [];
	try {
		entries = await readdir(dir);
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (entry.endsWith(".part") || entry.endsWith(".part.fail")) {
			try {
				await unlink(join(dir, entry));
				removed++;
			} catch {
				/* locked or already gone */
			}
		}
	}
	return removed;
}

/**
 * Start (or resume) the background model download. Idempotent: if the model
 * is already ready or a download is running, it returns immediately.
 */
export async function startModelDownload(dir = modelDir(), mirrors = MODEL_MIRRORS) {
	// Claim the download SYNCHRONOUSLY, before the first await.
	// The readiness probe below suspends, so a second caller arriving while it
	// is in flight (another browser tab, the settings page, a retried hotkey)
	// used to pass the running guard too — two writers then interleaved into
	// the same <file>.part and fought over the final rename.
	if (downloadState.running || downloadClaimed) {
		return { ok: true, started: false, reason: "running" };
	}
	downloadClaimed = true;
	downloadState.error = "";
	downloadState.progress = { file: "", done: 0, total: 0 };
	if (await modelReady(dir)) {
		downloadClaimed = false;
		return { ok: true, started: false, reason: "ready" };
	}
	downloadState.running = true;

	void (async () => {
		try {
			await mkdir(dir, { recursive: true });
			await cleanStaleParts(dir);
			// tokens first (tiny), then the big model — a ready marker only
			// counts when BOTH files exist. The skip test uses the same size
			// floors as modelReady(), so a stub that modelReady() rejects is
			// refetched instead of being trusted forever.
			for (const file of ["tokens.txt", "model.int8.onnx"]) {
				const floor = file === "tokens.txt" ? MIN_TOKENS_BYTES : MIN_MODEL_BYTES;
				if (await fileBigEnough(join(dir, file), floor)) continue;
				const result = await downloadFile(mirrors, file, dir, (f, done, total) => {
					downloadState.progress = { file: f, done, total };
				});
				if (!result.ok) {
					downloadState.error = "download failed: " + result.errors.join("; ");
					return;
				}
			}
		} catch (error) {
			downloadState.error = "download error: " + (error && error.message ? error.message : String(error));
		} finally {
			downloadState.running = false;
			downloadClaimed = false;
		}
	})();
	return { ok: true, started: true };
}

// ── recognizer (sherpa-onnx, singleton + serialized decode) ────────────────

let recognizer = null;
let recognizerDir = null;
/** In-flight load memo: concurrent transcriptions must share ONE load. */
let recognizerLoading = null;
let queue = Promise.resolve();

async function loadRecognizer(dir) {
	let sherpa;
	try {
		sherpa = require("sherpa-onnx-node");
	} catch (cause) {
		// sherpa-onnx-node is an OPTIONAL dependency: it ships native binaries
		// and has no prebuild for every platform. Only the LOCAL engine needs
		// it — cloud ASR and Web Speech work fine without it — so a missing
		// module must surface as a clear, actionable message instead of an
		// opaque MODULE_NOT_FOUND stack.
		const error = new Error("本地离线识别不可用：sherpa-onnx-node 未安装，或当前平台没有预编译产物。请在设置中改用云端 ASR 或浏览器 Web Speech。");
		error.code = "local-engine-unavailable";
		error.cause = cause;
		throw error;
	}
	const { OfflineRecognizer } = sherpa;
	const { model, tokens } = modelFiles(dir);
	return new OfflineRecognizer({
		modelConfig: {
			senseVoice: { model, language: "auto", useInverseTextNormalization: 1 },
			tokens,
			provider: "cpu",
			numThreads: 4
		},
		featConfig: { sampleRate: TARGET_SAMPLE_RATE, featureDim: 80 }
	});
}

/**
 * Get (or lazily load) the recognizer singleton. Concurrent callers share a
 * single in-flight load — without the memo, two overlapping transcriptions
 * each constructed an OfflineRecognizer, loading the ~230 MB model TWICE.
 * @param {string} [dir]
 * @param {(dir: string) => Promise<any>} [loader] injectable for tests
 */
export async function ensureRecognizer(dir = modelDir(), loader = loadRecognizer) {
	if (recognizer !== null && recognizerDir === dir) return recognizer;
	if (recognizerLoading === null) {
		recognizerLoading = (async () => {
			if (!(await modelReady(dir))) {
				const error = new Error("SenseVoice 模型未就绪（首次使用会自动下载，或调用 local-download）");
				error.code = "model-not-ready";
				throw error;
			}
			return loader(dir);
		})();
	}
	let rec;
	try {
		rec = await recognizerLoading;
	} finally {
		// Safe to clear for every awaiter: all concurrent callers hold the
		// same promise reference, and later callers re-check recognizer first.
		recognizerLoading = null;
	}
	recognizer = rec;
	recognizerDir = dir;
	return rec;
}

/** Strip SenseVoice's leading metadata tokens (<|zh|><|NEUTRAL|>…). */
export function cleanupSenseVoiceText(text) {
	if (typeof text !== "string") return "";
	return text.replace(/<\|[^|]*\|>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Transcribe 16 kHz mono float32 samples. Decodes are serialized — the
 * sherpa-onnx handle is not thread-safe.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {string} [dir]
 * @returns {Promise<string>}
 */
export async function transcribePcm(samples, sampleRate, dir = modelDir(), signal) {
	if (!(samples instanceof Float32Array) || samples.length === 0) {
		return "";
	}
	if (signal && signal.aborted) throw abortedError();
	const rec = await ensureRecognizer(dir);
	const run = () => {
		// A client that already hung up must not keep a core-busy decode — or a
		// queued one behind it — running for tens of seconds: the next transcribe
		// would wait for it and then time out with the transcript dropped.
		if (signal && signal.aborted) throw abortedError();
		const stream = rec.createStream();
		stream.acceptWaveform({ samples, sampleRate });
		return rec.decodeAsync(stream);
	};
	const result = await (queue = queue.then(run, run));
	return cleanupSenseVoiceText(result && typeof result.text === "string" ? result.text : "");
}

/** Cancellation error for an abandoned request (the host maps it to asr-aborted). */
function abortedError() {
	const error = new Error("已取消");
	error.code = "asr-aborted";
	return error;
}

/** Decode base64 little-endian f32 PCM bytes into a Float32Array. */
export function base64ToFloat32(base64) {
	if (typeof base64 !== "string" || base64 === "") return new Float32Array(0);
	const buf = Buffer.from(base64, "base64");
	if (buf.byteLength % 4 !== 0) {
		// tolerate a trailing partial sample by truncating
		const truncated = buf.subarray(0, buf.byteLength - (buf.byteLength % 4));
		return new Float32Array(truncated.buffer, truncated.byteOffset, truncated.byteLength / 4);
	}
	return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** For tests: drop the singleton so a fresh recognizer can be built. */
export function disposeRecognizer() {
	recognizer = null;
	recognizerDir = null;
	recognizerLoading = null;
}
