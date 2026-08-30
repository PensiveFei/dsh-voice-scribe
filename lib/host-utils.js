// ============================================================================
// dsh-voice-scribe — host-side pure helpers (no DSH imports).
//
// Everything in this module is dependency-free so the offline test suite
// (tests/run-tests.cjs) can import it directly and exercise real behaviour
// instead of matching source text.
// ============================================================================

import { homedir } from "node:os";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

/** Max accepted request body (audio base64; a few minutes of speech is < 10 MB). */
export const MAX_BODY_BYTES = 24 * 1024 * 1024;
/** Default ASR endpoint: Groq whisper-large-v3 (free tier, OpenAI-compatible). */
export const DEFAULT_ASR_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
export const DEFAULT_ASR_MODEL = "whisper-large-v3";
/** Timeout for one ASR call. */
export const TRANSCRIBE_TIMEOUT_MS = 60_000;
/** Cap on cloud providers tried per request (failover chain). */
export const MAX_ASR_PROVIDERS = 4;

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

// ── polish prompt (customizable system prompt; default = built-in text) ────

/** Built-in polish system prompt (used when no custom prompt is configured). */
export const DEFAULT_POLISH_PROMPT = [
	"你是一名语音转写校对助手。用户刚用语音输入了一段话。",
	"请仅做最小必要修正，保留原意与语气：",
	"1) 删除口头禅（嗯、啊、那个、就是就是等）；",
	"2) 修正明显的同音错字（如「在」「再」混淆）；",
	"3) 补全必要的标点（句号、逗号、问号）；",
	"4) 处理自我纠正（如「不是A，是B」）；",
	"5) 不要改写、不要扩写、不要添加内容。",
	"只输出修正后的文本本身，不要任何解释。"
].join("\n");

/** Cap on a custom polish prompt (the LLM must still see the transcript). */
export const MAX_POLISH_PROMPT_CHARS = 8000;

/**
 * Resolve the polish system prompt from settings: a non-empty custom prompt
 * wins; missing / blank falls back to the default. The prompt is stored
 * host-side (voice-input.json) and never leaves the host.
 */
export function resolvePolishPrompt(settings) {
	const custom = settings && typeof settings === "object" && typeof settings.polishPrompt === "string"
		? settings.polishPrompt.trim()
		: "";
	return custom !== "" ? custom : DEFAULT_POLISH_PROMPT;
}

// ── local rule-based pre-polish (runs before the LLM to save tokens) ────────

/** Filler syllables with no alternate reading — always safe to drop. */
const FILLER_CHARS_GLOBAL = /[嗯呃]+/g;
/** Whole filler phrases (stutters and trailing 然后呢) — safe anywhere. */
const FILLER_PHRASES = ["就是就是", "那个那个", "这个这个", "然后然后", "然后呢"];

/**
 * Deterministic local pre-polish applied before the transcript reaches the
 * LLM: strips the most common speech fillers and normalises whitespace so the
 * model sees cleaner, shorter input (fewer tokens). Deliberately conservative —
 * it never rewrites words, never invents punctuation mid-sentence, and only
 * adds a trailing terminator when the whole text has none. Anything it cannot
 * do safely is left to the LLM.
 */
export function localPolish(text) {
	if (typeof text !== "string") return "";
	let out = text.trim();
	if (out === "") return "";

	// 1) Whole filler phrases (stutters like 就是就是 / 那个那个).
	for (const phrase of FILLER_PHRASES) out = out.split(phrase).join("");

	// 2) Unambiguous filler syllables (runs of 嗯 / 呃), anywhere.
	out = out.replace(FILLER_CHARS_GLOBAL, "");

	// 3) Collapse whitespace; drop a space before CJK / ASCII punctuation.
	out = out.replace(/[ \t\r\n]+/g, " ").replace(/ +([，。！？、；：,.!?;:])/g, "$1").trim();

	// 4) Ensure one trailing sentence terminator when there is none.
	if (out !== "" && !/[。！？.!?…]$/.test(out)) {
		out += /[\u4e00-\u9fff]/.test(out) ? "。" : ".";
	}

	return out;
}

// ── hot words / regex replacement table (CapsWriter-style hot.txt) ─────────

/** Hot-words file inside the DSH home directory: $DSH_HOME/voice/hot.txt. */
const HOTWORDS_FILE = join("voice", "hot.txt");
/** Max replacement rules parsed from one hot.txt. */
export const MAX_HOTWORD_RULES = 1000;
/** Max hot.txt size read (a pathological file must not stall the host). */
export const MAX_HOTWORD_FILE_BYTES = 256 * 1024;

export function hotwordsPath() {
	const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
	return join(home, HOTWORDS_FILE);
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\// ── ASR (OpenAI-compatible /v1/audio/transcriptions) ───────────────────────");
}

/**
 * Split a "/pattern/replacement/flags" line on its unescaped "/" delimiters.
 * Returns null when the line is not regex form (no unescaped "/" after the opening one,
 * or 3+ unescaped delimiters which would be ambiguous).
 */
function splitRegexLine(line) {
	const parts = [];
	let buf = "";
	for (let i = 1; i < line.length; i++) {
		const ch = line[i];
		if (ch === "\\" && i + 1 < line.length) {
			// \/ is an escaped delimiter → literal "/"; every other escape
			// (\d, \s, …) passes through untouched.
			if (line[i + 1] === "/") { buf += "/"; }
			else { buf += ch + line[i + 1]; }
			i++;
			continue;
		}
		if (ch === "/") { parts.push(buf); buf = ""; continue; }
		buf += ch;
	}
	// Forms: /pattern/replacement/flags → parts=[pat, rep], buf=flags
	//        /pattern/replacement        → parts=[pat], buf=rep (no flags)
	if (parts.length === 0) return null;
	if (parts.length === 1) return { pattern: parts[0], replacement: buf, flags: "" };
	if (parts.length === 2) return { pattern: parts[0], replacement: parts[1], flags: buf };
	return null;
}

const VALID_REGEX_FLAGS = new Set(["d", "g", "i", "m", "s", "u", "v", "y"]);

/**
 * Parse hot.txt content into replacement rules. Line forms (blank lines and
 * #-comments are skipped):
 *   正确词=错误词1|错误词2      literal replace-all (case-insensitive)
 *   /正则/替换/flags            regex replace (standard $1 substitution)
 * Unparsable lines land in errors[] (line number + reason) so the settings UI
 * can surface them — one bad line must never disable the whole table.
 */
export function parseHotwords(content) {
	const rules = [];
	const errors = [];
	if (typeof content !== "string" || content.trim() === "") return { rules, errors };
	const lines = content.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "" || line.startsWith("#")) continue;
		if (rules.length >= MAX_HOTWORD_RULES) {
			errors.push({ line: i + 1, message: "规则数超过上限 " + MAX_HOTWORD_RULES + "，其余行被忽略" });
			break;
		}
		if (line.startsWith("/")) {
			const parsed = splitRegexLine(line);
			if (parsed === null) {
				errors.push({ line: i + 1, message: "正则行需要两个 / 分隔符：/正则/替换/flags" });
				continue;
			}
			let flags = "";
			let bad = false;
			for (const ch of parsed.flags) {
				if (!VALID_REGEX_FLAGS.has(ch)) {
					errors.push({ line: i + 1, message: "不支持的 RegExp 标志：" + JSON.stringify(ch) });
					bad = true;
					break;
				}
				flags += ch;
			}
			if (bad) continue;
			if (parsed.pattern === "") {
				errors.push({ line: i + 1, message: "正则表达式为空" });
				continue;
			}
			try {
				// Compile once here to validate; applyHotwords re-compiles per
				// call (a cached g-flagged regex keeps lastIndex across calls).
				new RegExp(parsed.pattern, flags);
			} catch (error) {
				errors.push({ line: i + 1, message: "正则表达式无效：" + safeMessage(error && error.message) });
				continue;
			}
			rules.push({ kind: "regex", source: parsed.pattern, flags, replacement: parsed.replacement });
			continue;
		}
		const eq = line.indexOf("=");
		if (eq <= 0) {
			errors.push({ line: i + 1, message: "无法识别的行（需要 正确词=错误词1|错误词2 或 /正则/替换/flags）" });
			continue;
		}
		const right = line.slice(0, eq).trim();
		const wrongs = line.slice(eq + 1).split("|").map((w) => w.trim()).filter((w) => w !== "");
		if (right === "" || wrongs.length === 0) {
			errors.push({ line: i + 1, message: "替换词与被替换词都不能为空" });
			continue;
		}
		rules.push({ kind: "literal", wrongs, right });
	}
	return { rules, errors };
}

/**
 * Apply replacement rules to a transcript, in file order. Literal rules
 * replace case-insensitively (ASR output casing is unpredictable); regex
 * rules use standard String.replace semantics ($1, // ── ASR (OpenAI-compatible /v1/audio/transcriptions) ─────────────────────── … work; escape a
 * literal $ as $). Invalid regex rules are skipped, never thrown.
 */
export function applyHotwords(text, rules) {
	if (typeof text !== "string" || text === "" || !Array.isArray(rules) || rules.length === 0) return text;
	let out = text;
	for (const rule of rules) {
		if (!rule || typeof rule !== "object") continue;
		if (rule.kind === "literal" && Array.isArray(rule.wrongs) && typeof rule.right === "string") {
			for (const wrong of rule.wrongs) {
				if (typeof wrong !== "string" || wrong === "") continue;
				out = out.replace(new RegExp(escapeRegExp(wrong), "gi"), () => rule.right);
			}
		} else if (rule.kind === "regex" && typeof rule.source === "string" && typeof rule.replacement === "string") {
			try {
				out = out.replace(new RegExp(rule.source, rule.flags || "g"), rule.replacement);
			} catch { /* invalid rule — skip */ }
		}
	}
	return out;
}

let hotwordsCache = null; // { path, sig, rules, errors }

/** Drop the hot.txt cache (tests; also forces a re-read after external edits). */
export function clearHotwordsCache() {
	hotwordsCache = null;
}

/**
 * Load + parse $DSH_HOME/voice/hot.txt with an mtime+size cache, so the file
 * is read at most once per change. A missing file simply means "no rules" —
 * the feature is opt-in: create hot.txt to enable it.
 */
export function loadHotwords() {
	const file = hotwordsPath();
	try {
		const stat = statSync(file);
		const sig = String(stat.mtimeMs) + ":" + String(stat.size);
		if (hotwordsCache && hotwordsCache.path === file && hotwordsCache.sig === sig) {
			return hotwordsCache;
		}
		const oversized = stat.size > MAX_HOTWORD_FILE_BYTES;
		const parsed = parseHotwords(oversized ? "" : readFileSync(file, "utf8"));
		hotwordsCache = oversized
			? { path: file, sig, rules: [], errors: [{ line: 0, message: "文件超过 " + MAX_HOTWORD_FILE_BYTES + " 字节，已忽略" }] }
			: { path: file, sig, rules: parsed.rules, errors: parsed.errors };
		return hotwordsCache;
	} catch {
		// Missing / unreadable file — no rules (the miss is cached per path).
		hotwordsCache = { path: file, sig: "", rules: [], errors: [] };
		return hotwordsCache;
	}
}

// ── ASR (OpenAI-compatible /v1/audio/transcriptions) ───────────────────────

/**
 * Resolve the ordered cloud-ASR provider chain from settings.
 *
 * Backwards-compatible: the old single-endpoint fields (asrUrl / asrModel /
 * asrApiKey) are folded in as the FIRST provider, and the newer
 * settings.asrProviders array (each { url, model, key? }) is appended after.
 * Entries without a URL, or beyond MAX_ASR_PROVIDERS, are dropped — a bad
 * provider must never break transcription for the ones before it.
 *
 * @param {{asrUrl?: string, asrModel?: string, asrApiKey?: string, asrProviders?: Array<{url: string, model?: string, key?: string}>}} settings
 * @returns {Array<{url: string, model: string, key: string}>}
 */
export function resolveAsrProviders(settings) {
	const providers = [];
	const push = (url, model, key) => {
		if (typeof url !== "string" || url.trim() === "") return;
		if (providers.length >= MAX_ASR_PROVIDERS) return;
		providers.push({
			url: url.trim(),
			model: (typeof model === "string" && model.trim() !== "") ? model.trim() : DEFAULT_ASR_MODEL,
			key: (typeof key === "string" && key.trim() !== "") ? key.trim() : ""
		});
	};
	if (settings && typeof settings === "object") {
		// Legacy single-endpoint fields fold in ONLY when actually present
		// (url or key set) — a bare {} must not resurrect a phantom default
		// row ahead of the configured chain.
		const hasLegacyUrl = typeof settings.asrUrl === "string" && settings.asrUrl.trim() !== "";
		const hasLegacyKey = typeof settings.asrApiKey === "string" && settings.asrApiKey.trim() !== "";
		if (hasLegacyUrl || hasLegacyKey) {
			const legacyUrl = hasLegacyUrl ? settings.asrUrl : DEFAULT_ASR_URL;
			push(legacyUrl, settings.asrModel, settings.asrApiKey);
		}
		if (Array.isArray(settings.asrProviders)) {
			for (const p of settings.asrProviders) {
				if (p === null || typeof p !== "object") continue;
				push(p.url, p.model, p.key);
			}
		}
	}
	if (providers.length === 0) push(DEFAULT_ASR_URL, DEFAULT_ASR_MODEL, "");
	return providers;
}

/**
 * Transcribe one recording via an OpenAI-compatible endpoint, trying each
 * configured provider in order. The first provider that returns text wins;
 * failures are collected and reported together so the user can see every
 * fallback's error instead of a single opaque failure.
 */
export async function transcribeAudio({ audioBase64, mimeType, language, settings, signal }) {
	const raw = Buffer.from(audioBase64, "base64");
	if (raw.byteLength === 0) {
		const error = new Error("empty audio");
		error.code = "audio-empty";
		throw error;
	}
	const providers = resolveAsrProviders(settings);
	const failures = [];
	for (const provider of providers) {
		try {
			return await transcribeOneProvider({ raw, mimeType, language, provider, signal });
		} catch (error) {
			failures.push({ provider, error });
		}
	}
	// All providers failed — build a combined error.
	//  - ONE provider: keep its original code (asr-http / asr-timeout / …)
	//  - MULTIPLE providers: aggregate; only asr-key-missing survives as-is
	//    (it is a config problem shared by every row), everything else maps
	//    to asr-failed so the UI shows the whole chain's errors.
	const firstCode = failures[0] && failures[0].error && failures[0].error.code;
	const allSameCode = failures.length > 0 && failures.every((f) => f.error && f.error.code === firstCode);
	if (failures.length === 1 && allSameCode && firstCode === "asr-key-missing") {
		const error = new Error("ASR API key is not configured (Settings → 语音输入)");
		error.code = "asr-key-missing";
		throw error;
	}
	const detail = failures.map((f) => {
		const label = f.provider && f.provider.url ? f.provider.url.replace(/^https?:\/\//, "").split("/")[0] : "unknown";
		const msg = f.error && f.error.message ? f.error.message : String(f.error);
		return label + ": " + msg;
	}).join("; ");
	const error = new Error("ASR request failed for all providers: " + detail);
	error.code = failures.length === 1 && allSameCode ? firstCode : "asr-failed";
	if (failures[0] && failures[0].error && failures[0].error.status) error.status = failures[0].error.status;
	throw error;
}

/**
 * One provider attempt: multipart POST (the shape OpenAI / Groq /
 * SiliconFlow / most proxies all accept).
 */
async function transcribeOneProvider({ raw, mimeType, language, provider, signal }) {
	if (provider.key === "") {
		const error = new Error("ASR API key is not configured (Settings → 语音输入)");
		error.code = "asr-key-missing";
		throw error;
	}
	const body = new FormData();
	const ext = mimeType === "audio/webm" ? "webm" : mimeType === "audio/mp4" || mimeType === "audio/m4a" ? "m4a" : mimeType === "audio/ogg" ? "ogg" : mimeType === "audio/wav" ? "wav" : "webm";
	body.append("file", new Blob([raw], { type: mimeType }), "recording." + ext);
	body.append("model", provider.model);
	const lang = normalizeLanguageCode(language);
	if (lang !== "") body.append("language", lang);

	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), TRANSCRIBE_TIMEOUT_MS);
	const forwardAbort = () => timeout.abort(signal && signal.reason);
	if (signal) signal.addEventListener("abort", forwardAbort, { once: true });

	try {
		const res = await fetch(provider.url, {
			method: "POST",
			headers: {
				authorization: "Bearer " + provider.key
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
		if (error && (error.code === "asr-http" || error.code === "asr-empty")) throw error;
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