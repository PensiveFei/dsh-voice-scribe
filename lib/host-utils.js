// ============================================================================
// dsh-voice-scribe — host-side pure helpers (no DSH imports).
//
// Everything in this module is dependency-free so the offline test suite
// (tests/run-tests.cjs) can import it directly and exercise real behaviour
// instead of matching source text.
// ============================================================================

import { homedir } from "node:os";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

/** Max accepted request body (audio base64; a few minutes of speech is < 10 MB). */
export const MAX_BODY_BYTES = 24 * 1024 * 1024;
/** Default ASR endpoint: Groq whisper-large-v3 (free tier, OpenAI-compatible). */
export const DEFAULT_ASR_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
export const DEFAULT_ASR_MODEL = "whisper-large-v3";
/** Timeout for one ASR call. */
export const TRANSCRIBE_TIMEOUT_MS = 60_000;

/** Settings file name inside the DSH home directory. */
const SETTINGS_FILE = "voice-input.json";

// ── settings (host-side; key never leaves the host) ────────────────────────

export function settingsPath() {
	const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
	return join(home, SETTINGS_FILE);
}

export function readSettings() {
	try {
		const parsed = JSON.parse(readFileSync(settingsPath(), "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export function writeSettings(settings) {
	const file = settingsPath();
	mkdirSync(dirname(file), { recursive: true });
	// The file holds the user's ASR API key — owner-only on POSIX (ignored on Windows).
	writeFileSync(file, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
}

// ── trust fence (same as dsh-dream-skin / dsh-better-sidebar) ──────────────

export function parseAuthority(authority) {
	try {
		return new URL("http://" + authority);
	} catch {
		return undefined;
	}
}

export function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4
		&& parts[0] === "127"
		&& parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function canonicalAuthority(entry, entryUrl) {
	const port = entryUrl.port !== "" ? entryUrl.port : new URL("https://" + entry).port;
	return port === "" ? entryUrl.hostname : entryUrl.hostname + ":" + port;
}

export function assertTrustedAuthority(entry) {
	const entryUrl = parseAuthority(entry);
	if (entryUrl !== undefined && canonicalAuthority(entry, entryUrl) === entry.toLowerCase()) return;
	throw new Error("dsh-voice-scribe: trustedHosts entry " + JSON.stringify(entry) + " is not a bare host[:port] authority");
}

export function isTrustedAuthority(hostUrl, trustedHosts) {
	return trustedHosts.some((entry) => {
		const entryUrl = parseAuthority(entry);
		if (entryUrl === undefined) return false;
		return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
			? entryUrl.hostname === hostUrl.hostname
			: entryUrl.host === hostUrl.host;
	});
}

export function isTrustedApiRequest(req, trustedHosts) {
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

/**
 * Validate + filter trustedHosts ONCE at startup. Keeps the per-request trust
 * check free of throws, so one bad user-configured entry can never take down
 * every API call with a 500.
 */
export function buildTrustedHosts(entries, warn) {
	const out = [];
	for (const entry of entries) {
		try {
			assertTrustedAuthority(entry);
			out.push(entry);
		} catch (error) {
			if (warn) warn(error && error.message ? error.message : String(error));
		}
	}
	return out;
}

// ── JSON body / response helpers ───────────────────────────────────────────

/** Sentinel: readJsonBody resolved with this when the body exceeds the limit. */
export const PAYLOAD_TOO_LARGE = Symbol("payload-too-large");

/**
 * Read + JSON.parse a request body with a size cap.
 * On overflow it RESOLVES with PAYLOAD_TOO_LARGE (instead of destroying the
 * stream and hanging forever), so the caller can answer 413 immediately.
 */
export function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
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
			if (size > maxBytes && !aborted) {
				aborted = true;
				// Stop buffering; hand control back so the caller can reply 413.
				// (The request is not destroyed here — the 413 response still
				// has to reach the client.)
				req.pause();
				resolve(PAYLOAD_TOO_LARGE);
			}
		});
		req.on("end", () => {
			if (aborted) return;
			try {
				const raw = Buffer.concat(chunks).toString("utf8").trim();
				resolve(raw === "" ? null : JSON.parse(raw));
			} catch {
				resolve(null);
			}
		});
		req.on("error", () => {
			if (!aborted) resolve(null);
		});
	});
}

export function writeJson(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store"
	});
	res.end(body);
}

/** Sanitize a string for log / error output (never echo raw provider errors with credentials). */
export function safeMessage(value) {
	if (typeof value !== "string") return "unknown error";
	return value.length > 500 ? value.slice(0, 500) + "…" : value;
}

/**
 * Normalize an OpenAI-compatible language code to its primary subtag:
 * "zh-CN" -> "zh", "en-US" -> "en". Unlike slice(0, 2) this keeps 3-letter
 * codes such as "yue" (Cantonese) intact.
 */
export function normalizeLanguageCode(language) {
	return typeof language === "string" ? language.trim().split("-")[0].toLowerCase() : "";
}

// ── ASR (OpenAI-compatible /v1/audio/transcriptions) ───────────────────────

/**
 * Transcribe one audio recording via an OpenAI-compatible endpoint.
 * The browser sends base64 audio; we decode it and re-POST as multipart
 * (the shape OpenAI / Groq / SiliconFlow / most proxies all accept).
 */
export async function transcribeAudio({ audioBase64, mimeType, language, settings, signal }) {
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
	body.append("file", new Blob([raw], { type: mimeType }), "recording." + ext);
	body.append("model", model);
	const lang = normalizeLanguageCode(language);
	if (lang !== "") body.append("language", lang);

	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), TRANSCRIBE_TIMEOUT_MS);
	const forwardAbort = () => timeout.abort(signal && signal.reason);
	if (signal) signal.addEventListener("abort", forwardAbort, { once: true });

	try {
		const res = await fetch(baseUrl, {
			method: "POST",
			headers: {
				authorization: "Bearer " + apiKey
			},
			body,
			signal: timeout.signal
		});
		const data = await res.json().catch(() => null);
		if (!res.ok) {
			const error = new Error("ASR request failed (" + res.status + "): " + safeMessage(data && (data.error && (data.error.message || data.error.code)) || JSON.stringify(data)));
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
