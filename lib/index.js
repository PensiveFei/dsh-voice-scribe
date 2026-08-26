// ============================================================================
// dsh-voice-scribe — host half.
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
//
// Dependency-free helpers (settings, trust fence, body reading, ASR call)
// live in ./host-utils.js so the offline test suite can import them directly.
// ============================================================================

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
	DEFAULT_ASR_URL,
	DEFAULT_ASR_MODEL,
	PAYLOAD_TOO_LARGE,
	buildTrustedHosts,
	isTrustedApiRequest,
	readJsonBody,
	readSettings,
	safeMessage,
	transcribeAudio,
	writeJson,
	writeSettings
} from "./host-utils.js";

/** Plugin identity for cordis.yml rows. */
export const name = "dsh-voice-scribe";
/** Services required before mounting: web routes, trust fence host list, and the DSH LLM runtime. */
export const inject = ["webServer", "webRuntime", "llm"];

/** Route prefix owned by this plugin. */
const API_PREFIX = "/voice-input";
/** Max transcript chars accepted into the LLM polish call. */
const MAX_TRANSCRIPT_CHARS = 12_000;
/** Timeout for one polish call. */
const POLISH_TIMEOUT_MS = 30_000;

// ── LLM polish (reuses DSH's configured models — zero extra config) ────────

/**
 * Polish a transcript through the DSH-configured LLM route (ctx.llm).
 * Provider + model are chosen by the user from DSH's own model list; the API
 * key comes from DSH's provider credentials — nothing new to configure.
 * Any failure (timeout / route error / stream error) keeps the raw transcript.
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
		// The request body was not fully consumed — close the connection after
		// the 413 so the socket does not linger half-drained.
		res.setHeader("connection", "close");
		writeJson(res, 413, { ok: false, error: { code: "payload-too-large", message: "request body too large" } });
		return;
	}
	if (payload === null || typeof payload !== "object" || typeof payload.action !== "string") {
		writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "bad request" } });
		return;
	}

	// Abort wiring: if the browser disconnects mid-request, cancel the
	// in-flight ASR / polish call instead of letting it run to its timeout.
	const abort = new AbortController();
	const onDisconnect = () => abort.abort();
	req.on("aborted", onDisconnect);
	res.on("close", () => {
		if (!res.writableEnded) onDisconnect();
	});

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
	// Empty/whitespace string values DELETE the field (lets the UI clear the
	// stored key); asrUrl must be an http(s) URL.
	if (payload.action === "set-settings") {
		const patch = payload.patch;
		if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
			writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "patch must be a plain object" } });
			return;
		}
		const next = readSettings();
		for (const [key, value] of Object.entries(patch)) {
			if (key !== "asrUrl" && key !== "asrModel" && key !== "language" && key !== "asrApiKey") continue;
			if (value === null) {
				delete next[key];
				continue;
			}
			if (typeof value !== "string") continue;
			const trimmed = value.trim();
			if (key === "asrUrl" && trimmed !== "" && !/^https?:\/\//i.test(trimmed)) {
				writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "asrUrl must be an http(s) URL" } });
				return;
			}
			if (trimmed === "") delete next[key];
			else next[key] = trimmed;
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
			const text = await transcribeAudio({ audioBase64: audio, mimeType, language, settings, signal: abort.signal });
			writeJson(res, 200, { ok: true, text });
		} catch (error) {
			console.error("[dsh-voice-scribe] transcribe failed:", safeMessage(error && error.message));
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
			const polished = await polishText({ text, provider, model, ctx, signal: abort.signal });
			writeJson(res, 200, { ok: true, text: polished });
		} catch (error) {
			console.error("[dsh-voice-scribe] polish failed:", safeMessage(error && error.message));
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

	writeJson(res, 404, { ok: false, error: { code: "not-found", message: "unknown action " + JSON.stringify(payload.action) } });
}

/** Host loader entry: mount the fenced voice-input API. */
export function apply(ctx) {
	// Validate/filter trustedHosts ONCE at startup — a bad entry must not
	// throw inside the per-request handler (which would 500 every call).
	const trustedHosts = buildTrustedHosts(ctx.webRuntime.trustedHosts, (message) => {
		console.warn("[dsh-voice-scribe] ignoring invalid trustedHosts entry:", message);
	});

	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: async (req, res) => {
			if (!isTrustedApiRequest(req, trustedHosts)) {
				writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
				return;
			}
			try {
				await handleApi(req, res, ctx);
			} catch (error) {
				// Never echo internal errors back to the browser.
				console.error("[dsh-voice-scribe] API error:", error);
				writeJson(res, 500, { ok: false, error: { code: "internal", message: "internal error" } });
			}
		}
	}), "dsh-voice-scribe: API routes");
}
