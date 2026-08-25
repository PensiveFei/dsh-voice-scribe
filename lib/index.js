// ============================================================================
// dsh-voice-input — host half.
//
// Routes (fenced to loopback / trusted hosts, same-origin only):
//   POST /voice-input/transcribe   { audio: base64, mimeType, language? } -> { ok, text }
//        decodes audio, POSTs it to the configured ASR endpoint
//        (OpenAI-compatible /v1/audio/transcriptions), returns the text.
//   POST /voice-input/polish       { text, provider, model } -> { ok, text }
//        optionally re-runs the transcript through the DSH-configured LLM
//        (ctx.llm) to strip fillers / fix punctuation. Zero extra config:
//        provider + model are picked from DSH's own model list.
//
// The browser half keeps its settings (ASR base URL / key / language / hotkey
// / polish on-off) in localStorage; the API key is NEVER sent to the browser.
// The browser posts only the audio + the chosen language; the host resolves
// the key from its own settings scope (host-side, not exposed to the page).
// ============================================================================

import { homedir } from "node:os";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

/** Plugin identity for cordis.yml rows. */
export const name = "dsh-voice-input";
/** Services required before mounting: web routes, trust fence host list, and the DSH LLM runtime. */
export const inject = ["webServer", "webRuntime", "llm"];

/** Route prefix owned by this plugin. */
const API_PREFIX = "/voice-input";
/** Max accepted request body (audio base64; a few minutes of speech is < 10 MB). */
const MAX_BODY_BYTES = 24 * 1024 * 1024;
/** Default ASR endpoint: Groq whisper-large-v3 (free tier, OpenAI-compatible). */
const DEFAULT_ASR_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const DEFAULT_ASR_MODEL = "whisper-large-v3";
/** Max transcript chars accepted into the LLM polish call. */
const MAX_TRANSCRIPT_CHARS = 12_000;
/** Timeout for one ASR / polish call. */
const TRANSCRIBE_TIMEOUT_MS = 60_000;
const POLISH_TIMEOUT_MS = 30_000;

// ── settings (host-side; key never leaves the host) ────────────────────────

/** Settings file name inside the DSH home directory. */
const SETTINGS_FILE = "voice-input.json";

function settingsPath() {
	const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
	return join(home, SETTINGS_FILE);
}

function readSettings() {
	try {
		const parsed = JSON.parse(readFileSync(settingsPath(), "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function writeSettings(settings) {
	const file = settingsPath();
	mkdirSync(dirname(file), { recursive: true });
	// The file holds the user's ASR API key — owner-only on POSIX (ignored on Windows).
	writeFileSync(file, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
}

// ── trust fence (same as dsh-dream-skin / dsh-better-sidebar) ──────────────

function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`);
	} catch {
		return undefined;
	}
}

function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4
		&& parts[0] === "127"
		&& parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function canonicalAuthority(entry, entryUrl) {
	const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
	return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

function assertTrustedAuthority(entry) {
	const entryUrl = parseAuthority(entry);
	if (entryUrl !== undefined && canonicalAuthority(entry, entryUrl) === entry.toLowerCase()) return;
	throw new Error(`dsh-voice-input: trustedHosts entry ${JSON.stringify(entry)} is not a bare host[:port] authority`);
}

function isTrustedAuthority(hostUrl, trustedHosts) {
	return trustedHosts.some((entry) => {
		assertTrustedAuthority(entry);
		const entryUrl = parseAuthority(entry);
		if (entryUrl === undefined) return false;
		return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
			? entryUrl.hostname === hostUrl.hostname
			: entryUrl.host === hostUrl.host;
	});
}

function isTrustedApiRequest(req, trustedHosts) {
	const host = typeof req.headers.host === "string" ? req.headers.host : undefined;
	if (host === undefined) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === undefined) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

// ── JSON body / response helpers ───────────────────────────────────────────

const PAYLOAD_TOO_LARGE = Symbol("payload-too-large");

function readJsonBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		let aborted = false;
		req.on("data", (chunk) => {
			// Normalize: some hosts / middleware deliver strings (setEncoding),
			// some deliver Buffers. Buffer.concat needs Buffers.
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
			chunks.push(buf);
			size += buf.length;
			if (size > MAX_BODY_BYTES && !aborted) {
				aborted = true;
				req.destroy();
			}
		});
		req.on("end", () => {
			if (aborted) return;
			try {
				const raw = Buffer.concat(chunks).toString("utf8").trim();
				const parsed = raw === "" ? null : JSON.parse(raw);
				resolve(parsed);
			} catch {
				resolve(null);
			}
		});
		req.on("error", () => {
			if (!aborted) resolve(null);
		});
	});
}

function writeJson(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store"
	});
	res.end(body);
}

/** Sanitize a string for log / error output (never echo raw provider errors with credentials). */
function safeMessage(value) {
	if (typeof value !== "string") return "unknown error";
	return value.length > 500 ? value.slice(0, 500) + "…" : value;
}

// ── ASR (OpenAI-compatible /v1/audio/transcriptions) ───────────────────────

/**
 * Transcribe one audio recording via an OpenAI-compatible endpoint.
 * The browser sends base64 audio; we decode it and re-POST as multipart
 * (the shape OpenAI / Groq / SiliconFlow / most proxies all accept).
 */
async function transcribeAudio({ audioBase64, mimeType, language, settings, signal }) {
	const raw = Buffer.from(audioBase64, "base64");
	if (raw.byteLength === 0) {
		const error = new Error("empty audio");
		error.code = "audio-empty";
		throw error;
	}
	const baseUrl = (settings.asrUrl && settings.asrUrl.trim()) || DEFAULT_ASR_URL;
	const model = (settings.asrModel && settings.asrModel.trim()) || DEFAULT_ASR_MODEL;
	const apiKey = (settings.asrApiKey && settings.asrApiKey.trim()) || "";

	if (apiKey === "") {
		const error = new Error("ASR API key is not configured (Settings → 语音输入)");
		error.code = "asr-key-missing";
		throw error;
	}

	const body = new FormData();
	const ext = mimeType === "audio/webm" ? "webm" : mimeType === "audio/mp4" || mimeType === "audio/m4a" ? "m4a" : mimeType === "audio/ogg" ? "ogg" : mimeType === "audio/wav" ? "wav" : "webm";
	body.append("file", new Blob([raw], { type: mimeType }), `recording.${ext}`);
	body.append("model", model);
	if (language && language.trim()) body.append("language", language.trim().slice(0, 2));

	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), TRANSCRIBE_TIMEOUT_MS);
	const forwardAbort = () => timeout.abort(signal && signal.reason);
	if (signal) signal.addEventListener("abort", forwardAbort, { once: true });

	try {
		const res = await fetch(baseUrl, {
			method: "POST",
			headers: {
				authorization: `Bearer ${apiKey}`
			},
			body,
			signal: timeout.signal
		});
		const data = await res.json().catch(() => null);
		if (!res.ok) {
			const error = new Error(`ASR request failed (${res.status}): ${safeMessage(data && (data.error && (data.error.message || data.error.code)) || JSON.stringify(data))}`);
			error.code = "asr-http";
			error.status = res.status;
			throw error;
		}
		const text = data && typeof data.text === "string" ? data.text.trim() : "";
		if (text === "") {
			const error = new Error("ASR returned empty text");
			error.code = "asr-empty";
			throw error;
		}
		return text;
	} catch (error) {
		if (error && error.code === "asr-http") throw error;
		if (error && error.name === "AbortError") {
			const abort = new Error("ASR request timed out");
			abort.code = "asr-timeout";
			throw abort;
		}
		throw error;
	} finally {
		clearTimeout(timer);
		if (signal) signal.removeEventListener("abort", forwardAbort);
	}
}

// ── LLM polish (reuses DSH's configured models — zero extra config) ────────

/**
 * Polish a transcript through the DSH-configured LLM route (ctx.llm).
 * Provider + model are chosen by the user from DSH's own model list; the API
 * key comes from DSH's provider credentials — nothing new to configure.
 */
async function polishText({ text, provider, model, ctx, signal }) {
	const raw = text.trim();
	if (raw === "" || raw.length > MAX_TRANSCRIPT_CHARS) return raw;

	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), POLISH_TIMEOUT_MS);
	const forwardAbort = () => timeout.abort(signal && signal.reason);
	if (signal) signal.addEventListener("abort", forwardAbort, { once: true });

	try {
		const prepared = await ctx.llm.prepareCall({ provider, model }, timeout.signal);
		const message = createUserMessage({
			content: [{ type: "text", text: raw }],
			source: { kind: "user" }
		});
		const system = [
			"你是一名语音转写校对助手。用户刚用语音输入了一段话。",
			"请仅做最小必要修正，保留原意与语气：",
			"1) 删除口头禅（嗯、啊、那个、就是就是等）；",
			"2) 修正明显的同音错字（如「在」「再」混淆）；",
			"3) 补全必要的标点（句号、逗号、问号）；",
			"4) 处理自我纠正（如「不是A，是B」）；",
			"5) 不要改写、不要扩写、不要添加内容。",
			"只输出修正后的文本本身，不要任何解释。"
		].join("\n");

		let out = "";
		for await (const chunk of prepared.stream({
			...prepared.config,
			messages: [message],
			system,
			signal: timeout.signal
		})) {
			if (chunk.type === "text-delta") out += chunk.text;
			else if (chunk.type === "finish" && (chunk.reason.kind === "error" || chunk.reason.kind === "aborted")) {
				const error = new Error("polish route failed");
				error.code = "polish-route";
				throw error;
			}
		}
		const result = out.trim();
		return result === "" ? raw : result;
	} catch (error) {
		if (error && error.name === "AbortError") return raw; // timeout → keep raw transcript
		if (error && error.code === "polish-route") return raw; // route error → keep raw
		return raw; // any polish failure → keep the raw transcript (never lose the user's words)
	} finally {
		clearTimeout(timer);
		if (signal) signal.removeEventListener("abort", forwardAbort);
	}
}

// ── request handling ───────────────────────────────────────────────────────

async function handleApi(req, res, ctx) {
	if (req.method !== "POST") {
		writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } });
		return;
	}
	const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"].toLowerCase() : "";
	if (!contentType.startsWith("application/json")) {
		writeJson(res, 415, { ok: false, error: { code: "unsupported-media-type", message: "content-type must be application/json" } });
		return;
	}
	const payload = await readJsonBody(req);
	if (payload === PAYLOAD_TOO_LARGE) {
		writeJson(res, 413, { ok: false, error: { code: "payload-too-large", message: "request body too large" } });
		return;
	}
	if (payload === null || typeof payload !== "object" || typeof payload.action !== "string") {
		writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "bad request" } });
		return;
	}

	// GET-style settings read: exposes only non-secret view (never the key).
	if (payload.action === "get-settings") {
		const settings = readSettings();
		writeJson(res, 200, {
			ok: true,
			value: {
				asrUrl: settings.asrUrl || DEFAULT_ASR_URL,
				asrModel: settings.asrModel || DEFAULT_ASR_MODEL,
				language: settings.language || "",
				hasKey: !!(settings.asrApiKey && settings.asrApiKey.trim())
			}
		});
		return;
	}

	// Settings write: accepts only the safe fields; the key is stored host-side.
	if (payload.action === "set-settings") {
		const patch = payload.patch;
		if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
			writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "patch must be a plain object" } });
			return;
		}
		const next = readSettings();
		for (const [key, value] of Object.entries(patch)) {
			if (key !== "asrUrl" && key !== "asrModel" && key !== "language" && key !== "asrApiKey") continue;
			if (value === null) delete next[key];
			else if (typeof value === "string") next[key] = value;
		}
		writeSettings(next);
		writeJson(res, 200, { ok: true });
		return;
	}

	// Transcribe: { audio: base64, mimeType, language? }
	if (payload.action === "transcribe") {
		const audio = typeof payload.audio === "string" ? payload.audio : "";
		const mimeType = typeof payload.mimeType === "string" ? payload.mimeType : "audio/webm";
		const language = typeof payload.language === "string" ? payload.language : "";
		const settings = readSettings();
		try {
			const text = await transcribeAudio({ audioBase64: audio, mimeType, language, settings });
			writeJson(res, 200, { ok: true, text });
		} catch (error) {
			console.error("[dsh-voice-input] transcribe failed:", safeMessage(error && error.message));
			writeJson(res, 200, { ok: false, error: { code: error && error.code || "transcribe-failed", message: safeMessage(error && error.message) } });
		}
		return;
	}

	// Polish: { text, provider, model }
	if (payload.action === "polish") {
		const text = typeof payload.text === "string" ? payload.text : "";
		const provider = typeof payload.provider === "string" ? payload.provider : "";
		const model = typeof payload.model === "string" ? payload.model : "";
		if (text === "" || provider === "" || model === "") {
			writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "text, provider and model are required" } });
			return;
		}
		try {
			const polished = await polishText({ text, provider, model, ctx });
			writeJson(res, 200, { ok: true, text: polished });
		} catch (error) {
			console.error("[dsh-voice-input] polish failed:", safeMessage(error && error.message));
			// Never fail the flow on polish: the browser already has the raw transcript.
			writeJson(res, 200, { ok: false, error: { code: error && error.code || "polish-failed", message: safeMessage(error && error.message) } });
		}
		return;
	}

	// List DSH's configured LLM routes for the polish picker (no secrets).
	if (payload.action === "list-models") {
		const routes = [];
		for (const provider of ctx.llm.listProviders()) {
			let models = [];
			try {
				models = await ctx.llm.listModels(provider.id);
			} catch {
				continue;
			}
			for (const model of models) {
				routes.push({ provider: provider.id, providerName: provider.name, model: model.id, modelName: model.name });
			}
		}
		writeJson(res, 200, { ok: true, value: routes });
		return;
	}

	writeJson(res, 404, { ok: false, error: { code: "not-found", message: `unknown action "${payload.action}"` } });
}

/** Host loader entry: mount the fenced voice-input API. */
export function apply(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: async (req, res) => {
			if (!isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)) {
				writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
				return;
			}
			try {
				await handleApi(req, res, ctx);
			} catch (error) {
				// Never echo internal errors back to the browser.
				console.error("[dsh-voice-input] API error:", error);
				writeJson(res, 500, { ok: false, error: { code: "internal", message: "internal error" } });
			}
		}
	}), "dsh-voice-input: API routes");
}
