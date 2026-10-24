// SPDX-License-Identifier: MIT
// ============================================================================
// dsh-voice-scribe — host-side pure helpers (no DSH imports).
//
// Everything in this module is dependency-free so the offline test suite
// (tests/run-tests.cjs) can import it directly and exercise real behaviour
// instead of matching source text.
// ============================================================================

import { homedir } from "node:os";
import { readFileSync, writeFileSync, mkdirSync, statSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

/** Max accepted request body (audio base64; a few minutes of speech is < 10 MB). */
export const MAX_BODY_BYTES = 24 * 1024 * 1024;
/** Default ASR endpoint: Groq whisper-large-v3 (free tier, OpenAI-compatible). */
export const DEFAULT_ASR_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
export const DEFAULT_ASR_MODEL = "whisper-large-v3";
/** Timeout for one ASR call. */
export const TRANSCRIBE_TIMEOUT_MS = 60_000;
/** Cap on cloud providers tried per request (failover chain). */
export const MAX_ASR_PROVIDERS = 4;
/** Bound provider responses as well as uploads (including chunked responses). */
export const MAX_ASR_RESPONSE_BYTES = 1024 * 1024;

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
	// Replace atomically: a failed write must not truncate the previous keys.
	// A new owner-only inode also repairs an existing overly permissive file.
	const temporary = file + "." + randomUUID() + ".tmp";
	try {
		writeFileSync(temporary, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
		renameSync(temporary, file);
	} finally {
		try { unlinkSync(temporary); } catch { /* renamed, or not created */ }
	}
}

// ── trust fence (same as dsh-dream-skin / dsh-better-sidebar) ──────────────

export function parseAuthority(authority) {
	if (typeof authority !== "string" || authority === "" || /[\s\\/@?#]/.test(authority)) return undefined;
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
	// A missing / mis-shaped host config must not throw at startup — treat it
	// as "no trusted non-loopback hosts" instead of failing the whole plugin.
	for (const entry of Array.isArray(entries) ? entries : []) {
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
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			chunks.length = 0;
			resolve(value);
		};
		req.on("data", (chunk) => {
			if (settled) return;
			// Normalize: some hosts / middleware deliver strings (setEncoding),
			// some deliver Buffers. Buffer.concat needs Buffers.
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
			size += buf.length;
			if (size > maxBytes) {
				// Stop buffering; hand control back so the caller can reply 413.
				// (The request is not destroyed here — the 413 response still
				// has to reach the client.)
				req.pause();
				finish(PAYLOAD_TOO_LARGE);
				return;
			}
			chunks.push(buf);
		});
		req.on("end", () => {
			if (settled) return;
			try {
				const raw = Buffer.concat(chunks).toString("utf8").trim();
				finish(raw === "" ? null : JSON.parse(raw));
			} catch {
				finish(null);
			}
		});
		req.on("error", () => finish(null));
		req.on("aborted", () => finish(null));
		req.on("close", () => finish(null));
		if (req.aborted || req.destroyed) finish(null);
	});
}

export function writeJson(res, status, value) {
	// A client that hung up mid-request, or a handler that already answered,
	// must not turn a late reply into a write-after-end error on the response:
	// the 500 fallback in apply() would then throw from inside its own catch.
	if (res.writableEnded || res.destroyed) return;
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store"
	});
	res.end(body);
}

/** Sanitize a string for log / error output (never echo raw provider errors with credentials). */
export function safeMessage(value, secrets = []) {
	if (typeof value !== "string") return "unknown error";
	let out = value;
	for (const secret of secrets) {
		if (typeof secret !== "string" || secret === "") continue;
		for (const variant of new Set([secret, encodeURIComponent(secret)])) out = out.split(variant).join("[redacted]");
	}
	return out.length > 500 ? out.slice(0, 500) + "…" : out;
}

/** Enforce cancellation even when a provider ignores its AbortSignal. */
export function runWithSignal(task, signal) {
	if (!signal) return Promise.resolve().then(task);
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason || new DOMException("The operation was aborted", "AbortError"));
		if (signal.aborted) { onAbort(); return; }
		signal.addEventListener("abort", onAbort, { once: true });
		Promise.resolve().then(() => {
			signal.throwIfAborted();
			return task();
		}).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/** Only complete HTTP(S) endpoints without embedded user credentials. */
export function isValidAsrUrl(value) {
	if (typeof value !== "string" || !/^https?:\/\//i.test(value) || /[\s\\]/.test(value)) return false;
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "" && url.username === "" && url.password === "" && url.hash === "";
	} catch { return false; }
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

	// 4) Ensure one trailing sentence terminator when there is none. Every
	//    closing or separating mark counts: appending a 。 after ；or ）produced
	//    nonsense like 「已完成；。」 in the text handed to the LLM.
	if (out !== "" && !/[。！？…；：，、）】》」”’"'.!?]$/.test(out)) {
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
/** Per-transcript rule execution budget; the host thread never runs user regexes. */
export const HOTWORD_TIMEOUT_MS = 2000;
export const MAX_HOTWORD_OUTPUT_CHARS = 1024 * 1024;
const MAX_HOTWORD_WORKERS = 4;
let activeHotwordWorkers = 0;

export function hotwordsPath() {
	const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
	return join(home, HOTWORDS_FILE);
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
 * rules use standard String.replace semantics ($1, $& … work; escape a
 * literal $ as $$). Invalid regex rules are skipped, never thrown.
 */
export function applyHotwords(text, rules, maxOutputChars = Infinity) {
	if (typeof text !== "string" || text === "" || !Array.isArray(rules) || rules.length === 0) return text;
	if (text.length > maxOutputChars) throw new RangeError("hotword-output-limit");
	let out = text;
	for (const rule of rules) {
		if (!rule || typeof rule !== "object") continue;
		if (rule.kind === "literal" && Array.isArray(rule.wrongs) && typeof rule.right === "string") {
			for (const wrong of rule.wrongs) {
				if (typeof wrong !== "string" || wrong === "") continue;
				let outputSize = out.length;
				out = out.replace(new RegExp(escapeRegExp(wrong), "gi"), (match) => {
					outputSize += rule.right.length - match.length;
					if (outputSize > maxOutputChars) throw new RangeError("hotword-output-limit");
					return rule.right;
				});
			}
		} else if (rule.kind === "regex" && typeof rule.source === "string" && typeof rule.replacement === "string") {
			try {
				// A replacement rule exists to fix EVERY occurrence, but /错词/对词/i
				// (the JS/sed habit) used to replace only the first one — silently,
				// and for exactly the tokens this table exists to fix. An explicit g
				// (or sticky y) is still honoured exactly as written.
				const flags = rule.flags && /[gy]/.test(rule.flags) ? rule.flags : (rule.flags || "") + "g";
				out = out.replace(new RegExp(rule.source, flags), rule.replacement);
			} catch { /* invalid rule — skip */ }
		}
		if (out.length > maxOutputChars) throw new RangeError("hotword-output-limit");
	}
	return out;
}

/**
 * Run hot.txt rules off the host thread, retaining the original transcript if
 * matching hangs, replacements grow too large, or the client cancels. Syntax
 * stays unchanged, including captures/backreferences and literal dollar signs.
 */
export async function applyHotwordsBounded(text, rules, signal) {
	if (typeof text !== "string" || text === "" || !Array.isArray(rules) || rules.length === 0 || (signal && signal.aborted)) return text;
	if (text.length > MAX_HOTWORD_OUTPUT_CHARS || activeHotwordWorkers >= MAX_HOTWORD_WORKERS) {
		console.warn("[dsh-voice-scribe] hotword-budget-exceeded");
		return text;
	}
	let worker;
	try {
		worker = new Worker(new URL("./hotword-worker.js", import.meta.url), {
			workerData: { text, rules },
			execArgv: [],
			resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 }
		});
	} catch {
		console.warn("[dsh-voice-scribe] hotword-worker-unavailable");
		return text;
	}
	activeHotwordWorkers++;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value, code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
			activeHotwordWorkers--;
			worker.terminate().catch(() => {});
			if (code) console.warn("[dsh-voice-scribe] " + code);
			resolve(value);
		};
		const onAbort = () => finish(text);
		const timer = setTimeout(() => finish(text, "hotword-timeout"), HOTWORD_TIMEOUT_MS);
		worker.once("message", (value) => {
			if (value && typeof value.text === "string" && value.text.length <= MAX_HOTWORD_OUTPUT_CHARS) finish(value.text);
			else finish(text, "hotword-output-limit");
		});
		worker.once("error", () => finish(text, "hotword-worker-error"));
		worker.once("exit", () => finish(text, "hotword-worker-exit"));
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
		if (signal && signal.aborted) onAbort();
	});
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
	if (typeof audioBase64 !== "string" || audioBase64.length > MAX_BODY_BYTES || audioBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audioBase64)) {
		const error = new Error("audio must be valid base64 within the request size limit");
		error.code = "invalid-audio";
		throw error;
	}
	const raw = Buffer.from(audioBase64, "base64");
	if (raw.toString("base64") !== audioBase64) {
		const error = new Error("audio must use canonical base64 encoding");
		error.code = "invalid-audio";
		throw error;
	}
	if (raw.byteLength === 0) {
		const error = new Error("empty audio");
		error.code = "audio-empty";
		throw error;
	}
	const providers = resolveAsrProviders(settings);
	const failures = [];
	for (const provider of providers) {
		// The browser hung up: stop before POSTing to the rest of the chain
		// (4 x 60s of quota burned for a client that is already gone).
		if (signal && signal.aborted) break;
		try {
			return await transcribeOneProvider({ raw, mimeType, language, provider, signal });
		} catch (error) {
			failures.push({ provider, error });
		}
	}
	if (signal && signal.aborted) {
		const error = new Error("ASR request aborted by the client");
		error.code = "asr-aborted";
		throw error;
	}
	// All providers failed — build a combined error.
	//  - ONE provider: keep its original code (asr-http / asr-timeout / …)
	//  - MULTIPLE providers: aggregate; only asr-key-missing survives as-is
	//    (it is a config problem shared by every row), everything else maps
	//    to asr-failed so the UI shows the whole chain's errors.
	const firstCode = failures[0] && failures[0].error && failures[0].error.code;
	const allSameCode = failures.length > 0 && failures.every((f) => f.error && f.error.code === firstCode);
	if (allSameCode && firstCode === "asr-key-missing") {
		const error = new Error("ASR API key is not configured (Settings → 语音输入)");
		error.code = "asr-key-missing";
		throw error;
	}
	const detail = failures.map((f) => {
		let label = "unknown";
		try { label = new URL(f.provider.url).host; } catch { /* malformed settings */ }
		const msg = f.error && f.error.message ? f.error.message : String(f.error);
		return label + ": " + msg;
	}).join("; ");
	const error = new Error(safeMessage("ASR request failed for all providers: " + detail, providers.map((p) => p.key)));
	error.code = failures.length === 1 && allSameCode ? firstCode : "asr-failed";
	if (failures[0] && failures[0].error && failures[0].error.status) error.status = failures[0].error.status;
	throw error;
}

/**
 * One provider attempt: multipart POST (the shape OpenAI / Groq /
 * SiliconFlow / most proxies all accept).
 */
async function transcribeOneProvider({ raw, mimeType, language, provider, signal }) {
	if (!isValidAsrUrl(provider.url)) {
		const error = new Error("ASR endpoint must be a valid http(s) URL without embedded credentials");
		error.code = "asr-url-invalid";
		throw error;
	}
	if (provider.key === "") {
		const error = new Error("ASR API key is not configured (Settings → 语音输入)");
		error.code = "asr-key-missing";
		throw error;
	}
	const body = new FormData();
	const mediaType = typeof mimeType === "string" ? mimeType.split(";")[0].trim().toLowerCase() : "audio/webm";
	const ext = mediaType === "audio/mp4" || mediaType === "audio/m4a" ? "m4a" : mediaType === "audio/ogg" ? "ogg" : mediaType === "audio/wav" ? "wav" : "webm";
	body.append("file", new Blob([raw], { type: mimeType }), "recording." + ext);
	body.append("model", provider.model);
	const lang = normalizeLanguageCode(language);
	if (lang !== "") body.append("language", lang);

	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), TRANSCRIBE_TIMEOUT_MS);
	const forwardAbort = () => timeout.abort(signal && signal.reason);
	if (signal) signal.addEventListener("abort", forwardAbort, { once: true });
	// An AbortSignal that is ALREADY aborted never fires "abort" again for a
	// listener attached afterwards — forward the existing state explicitly,
	// otherwise this fetch runs the full timeout for a client that is gone.
	if (signal && signal.aborted) timeout.abort(signal.reason);

	try {
		const res = await runWithSignal(() => fetch(provider.url, {
			method: "POST",
			redirect: "error",
			headers: {
				authorization: "Bearer " + provider.key
			},
			body,
			signal: timeout.signal
		}), timeout.signal);
		const data = await runWithSignal(() => readAsrResponse(res, timeout.signal), timeout.signal);
		if (!res.ok) {
			const error = new Error("ASR request failed (" + res.status + "): " + safeMessage(data && (data.error && (data.error.message || data.error.code)) || JSON.stringify(data), [provider.key]));
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
		if (timeout.signal.aborted) {
			if (signal && signal.aborted) {
				const aborted = new Error("ASR request aborted by the client");
				aborted.code = "asr-aborted";
				throw aborted;
			}
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

async function readAsrResponse(res, signal) {
	// Non-stream response adapters are used by some hosts and offline tests.
	if (!res.body || typeof res.body.getReader !== "function") return res.json().catch(() => null);
	const reader = res.body.getReader();
	const onAbort = () => { reader.cancel().catch(() => {}); };
	if (signal) signal.addEventListener("abort", onAbort, { once: true });
	if (signal && signal.aborted) onAbort();
	const chunks = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_ASR_RESPONSE_BYTES) {
				const error = new Error("ASR response exceeds the size limit");
				error.code = "asr-response-too-large";
				throw error;
			}
			chunks.push(Buffer.from(value));
		}
		try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
	} finally {
		if (signal) signal.removeEventListener("abort", onAbort);
		// Cancellation must not itself block the timeout path.
		if (size > MAX_ASR_RESPONSE_BYTES) reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
