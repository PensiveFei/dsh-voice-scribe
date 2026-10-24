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
import { createHash } from "node:crypto";
import { finished } from "node:stream/promises";

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

/** Actual sizes of the pinned artifacts. Loose floors trusted a 160 MB
 * truncated model forever even though the upstream artifact is 239 MB. */
export const MIN_MODEL_BYTES = 239233841;
export const MIN_TOKENS_BYTES = 315894;

export async function modelReady(dir = modelDir(), minModelBytes = MIN_MODEL_BYTES, minTokensBytes = MIN_TOKENS_BYTES) {
	const { model, tokens } = modelFiles(dir);
	try {
		const [ms, ts] = await Promise.all([stat(model), stat(tokens)]);
		return ms.isFile() && ts.isFile() && ms.size >= minModelBytes && ts.size >= minTokensBytes
			&& (minModelBytes !== MIN_MODEL_BYTES || ms.size === MIN_MODEL_BYTES)
			&& (minTokensBytes !== MIN_TOKENS_BYTES || ts.size === MIN_TOKENS_BYTES);
	} catch {
		return false;
	}
}

// ── model download (mirrors, progress, atomic) ─────────────────────────────

const MODEL_BASE = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";
// Pin both mirrors to the same immutable upstream revision. These SHA-256
// digests are from the upstream LFS model metadata and tokens.txt at this
// revision, so an HTTP 200 HTML page or a corrupted mirror cannot be installed.
const MODEL_REVISION = "2365baeacb507f821a0c8120fcee3d484dba7a07";
const MODEL_DOWNLOAD_FILES = {
	"tokens.txt": { minBytes: 315894, maxBytes: 315894, sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc" },
	"model.int8.onnx": { minBytes: 239233841, maxBytes: 239233841, sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51" }
};
/** File-based mirrors (model.int8.onnx + tokens.txt). hf-mirror.com is the
 *  China-friendly HF mirror and is verified reachable on mainland networks. */
const MODEL_MIRRORS = [
	"https://hf-mirror.com/" + MODEL_BASE + "/resolve/" + MODEL_REVISION,
	"https://huggingface.co/" + MODEL_BASE + "/resolve/" + MODEL_REVISION
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
async function fileBigEnough(path, minBytes, maxBytes) {
	try {
		const info = await stat(path);
		return info.isFile() && info.size >= minBytes && info.size <= maxBytes;
	} catch {
		return false;
	}
}

/**
 * Download one file through the mirror list; the first mirror that answers
 * wins. Streams to <target>.part and renames on success (atomic-ish; a
 * partial download never masquerades as ready).
 */
async function downloadFile(mirrors, filename, targetDir, onProgress, spec) {
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
			const res = await fetch(url, { signal: AbortSignal.timeout(600_000), headers: { "accept-encoding": "identity" } });
			// Even an error response may have a large body: acquire its reader
			// before checking the status so every failed mirror is cancelled.
			reader = res.body ? res.body.getReader() : null;
			if (!res.ok) throw new Error("HTTP " + res.status);
			if (!reader) throw new Error("empty download response");
			const lengthHeader = res.headers.get("content-length");
			const total = lengthHeader === null || lengthHeader === "" ? 0 : Number(lengthHeader);
			if (!Number.isSafeInteger(total) || total < 0) throw new Error("invalid download content-length");
			if (total > spec.maxBytes) throw new Error("download exceeds maximum size (" + spec.maxBytes + " bytes)");
			const hash = spec.sha256 ? createHash("sha256") : null;
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
					if (done > spec.maxBytes) throw new Error("download exceeds maximum size (" + spec.maxBytes + " bytes)");
					if (hash) hash.update(value);
					// Honour backpressure: without awaiting drain, a fast mirror
					// on a slow disk buffers the whole 230 MB model in memory.
					if (!file.write(Buffer.from(value))) await Promise.race([once(file, "drain"), writeFailed]);
					onProgress(filename, done, total);
				}
			}
			// `finish` alone can precede the fd close; Windows cannot reliably
			// rename or remove the partial while that descriptor is still open.
			const fileFinished = finished(file);
			file.end();
			await Promise.race([fileFinished, writeFailed]);
			if (writeError) throw writeError;
			file = null;
			// A connection dropped mid-transfer ends the read loop WITHOUT an error, so
			// the truncated .part used to be renamed into place — and because
			// startModelDownload skips any non-empty file, that broken model became
			// permanent (the native recognizer then failed with an opaque error).
			if (total > 0 && done !== total) {
				throw new Error("truncated download (" + done + "/" + total + " bytes)");
			}
			if (done < spec.minBytes) throw new Error("download too small (" + done + "/" + spec.minBytes + " bytes)");
			if (hash && hash.digest("hex") !== spec.sha256) throw new Error("download SHA-256 mismatch");
			await rename(part, target);
			onProgress(filename, done, done);
			return { ok: true, bytes: done };
		} catch (error) {
			errors.push(mirror + ": " + (error && error.message ? error.message : String(error)));
			// Abandoning a response body without cancelling it leaves the mirror
			// streaming the remaining ~230 MB into a socket nobody reads, while the
			// next mirror already starts a second download on top of it.
			if (reader !== null) await reader.cancel().catch(() => {});
			if (file !== null) {
				const closed = finished(file).catch(() => {});
				file.destroy();
				await closed;
			}
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
export async function startModelDownload(dir = modelDir(), mirrors = MODEL_MIRRORS, options = {}) {
	// An explicit file-spec override supports deterministic tiny fixtures. The
	// runtime route uses the pinned defaults; no request field reaches options.
	const files = options.files || MODEL_DOWNLOAD_FILES;
	for (const name of ["tokens.txt", "model.int8.onnx"]) {
		const spec = files[name];
		if (!spec || !Number.isSafeInteger(spec.minBytes) || !Number.isSafeInteger(spec.maxBytes) || spec.minBytes < 1 || spec.maxBytes < spec.minBytes || (spec.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(spec.sha256))) {
			throw new TypeError("invalid model download file specification: " + name);
		}
	}
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
				if (await fileBigEnough(join(dir, file), floor, files[file].maxBytes)) continue;
				const result = await downloadFile(mirrors, file, dir, (f, done, total) => {
					downloadState.progress = { file: f, done, total };
				}, files[file]);
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
let recognizerGeneration = 0;
let queue = Promise.resolve();
let pendingTranscriptions = 0;
const MAX_PENDING_TRANSCRIPTIONS = 4;
const MAX_AUDIO_SECONDS = 600;

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
	if (recognizerLoading !== null) {
		if (recognizerLoading.dir === dir) return recognizerLoading.promise;
		// Never label a recognizer loaded from another DSH_HOME as this
		// directory. Wait for the current load before starting the next one.
		await recognizerLoading.promise.catch(() => {});
		return ensureRecognizer(dir, loader);
	}
	const generation = recognizerGeneration;
	const loading = { dir, promise: null };
	loading.promise = (async () => {
		if (!(await modelReady(dir))) {
			const error = new Error("SenseVoice 模型未就绪（首次使用会自动下载，或调用 local-download）");
			error.code = "model-not-ready";
			throw error;
		}
		const rec = await loader(dir);
		// disposeRecognizer may invalidate an in-flight load. Its original
		// callers can still finish, but it must not repopulate the singleton.
		if (generation === recognizerGeneration && recognizerLoading === loading) {
			recognizer = rec;
			recognizerDir = dir;
		}
		return rec;
	})().finally(() => {
		if (recognizerLoading === loading) recognizerLoading = null;
	});
	recognizerLoading = loading;
	return loading.promise;
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
	if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || samples.length > sampleRate * MAX_AUDIO_SECONDS) {
		throw invalidAudioError("无效的 PCM 采样率或音频时长（最多 10 分钟）");
	}
	for (const sample of samples) if (!Number.isFinite(sample)) throw invalidAudioError("PCM 音频包含无效采样值");
	if (pendingTranscriptions >= MAX_PENDING_TRANSCRIPTIONS) {
		const error = new Error("本地识别繁忙，请稍后重试");
		error.code = "asr-busy";
		throw error;
	}
	pendingTranscriptions++;
	try {
		const rec = await ensureRecognizer(dir);
		const run = async () => {
			// The native API has no cancellation primitive. Check before and
			// after decoding so abandoned queued work does not run, and abandoned
			// in-flight work cannot return a stale transcript to its caller.
			if (signal && signal.aborted) throw abortedError();
			const stream = rec.createStream();
			stream.acceptWaveform({ samples, sampleRate });
			const result = await rec.decodeAsync(stream);
			if (signal && signal.aborted) throw abortedError();
			return result;
		};
		const result = await (queue = queue.then(run, run));
		return cleanupSenseVoiceText(result && typeof result.text === "string" ? result.text : "");
	} finally {
		pendingTranscriptions--;
	}
}

/** Cancellation error for an abandoned request (the host maps it to asr-aborted). */
function abortedError() {
	const error = new Error("已取消");
	error.code = "asr-aborted";
	return error;
}

function invalidAudioError(message) {
	const error = new Error(message);
	error.code = "invalid-audio";
	return error;
}

/** Decode base64 little-endian f32 PCM bytes into a Float32Array. */
export function base64ToFloat32(base64) {
	if (typeof base64 !== "string" || base64 === "") return new Float32Array(0);
	// Buffer.from(base64) otherwise silently ignores invalid bytes, missing
	// padding and partial samples, passing malformed data to native inference.
	if (base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(base64)) {
		throw invalidAudioError("无效的 PCM base64 编码");
	}
	const buf = Buffer.from(base64, "base64");
	if (buf.toString("base64") !== base64 || buf.byteLength % 4 !== 0) throw invalidAudioError("PCM 音频字节不完整");
	// PCM is explicitly little endian, independent of the host architecture.
	const samples = new Float32Array(buf.byteLength / 4);
	for (let i = 0; i < samples.length; i++) {
		const value = buf.readFloatLE(i * 4);
		if (!Number.isFinite(value)) throw invalidAudioError("PCM 音频包含无效采样值");
		samples[i] = value;
	}
	return samples;
}

/** For tests: drop the singleton so a fresh recognizer can be built. */
export function disposeRecognizer() {
	recognizerGeneration++;
	recognizer = null;
	recognizerDir = null;
	recognizerLoading = null;
}
