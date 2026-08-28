// dsh-voice-scribe — browser half (client plugin bundle).
//
// Loaded by dsh-client-modules at /plugins/dsh-voice-input/client.js and
// executed through the vendored cordis Loader's lazy-CJS module table
// (window.__ModuleLoader__.load). The factory body is plain CJS with
// require() resolved against the shell's module table — the same shape the
// shipped ui-* packages' tsdown bundles emit.
//
// Interaction: tap Alt (or Alt+Space, configurable) to start recording, tap
// again to stop and transcribe. The transcript is inserted at the composer
// textarea's cursor, preserving the existing draft. Optional polish re-runs
// the text through the DSH-configured LLM (host route /voice-input/polish).
//
// Privacy: audio is sent to the host route /voice-input/transcribe which
// forwards it to the configured ASR endpoint. The ASR API key lives only in
// the host settings file — the browser never sees it.

window.__ModuleLoader__.load({
	id: "dsh-voice-scribe",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let _react = require("react");

		//#region constants & settings
		/** localStorage keys (same-origin persistence, mirrors dsh-dream-skin). */
		const SETTINGS_KEY = "dsh-voice-input:settings";
		const ENGINE_KEY = "dsh-voice-input:engine";
		const HOTKEY_KEY = "dsh-voice-input:hotkey";
		const POLISH_KEY = "dsh-voice-input:polish";
		const POLISH_MODEL_KEY = "dsh-voice-input:polish-model";
		const LANGUAGE_KEY = "dsh-voice-input:language";
		/** v0.2 migration marker: pre-0.2.0 persisted the old "web-speech"
		 *  default; upgraders must land on the new "auto" default instead. */
		const ENGINE_MIGRATED_KEY = "dsh-voice-input:engine-migrated-v2";
		/** Default ASR settings (mirror the host defaults; the key is never here). */
		const DEFAULT_ASR_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
		const DEFAULT_ASR_MODEL = "whisper-large-v3";
		/** Hotkeys: "alt" (single tap) or "alt-space" (fallback when the browser eats Alt). */
		const HOTKEYS = ["alt", "alt-space"];
		/** API prefix (must match lib/index.js). */
		const API_PREFIX = "/voice-input";
		/** Debounce so a quick double-tap of Alt does not toggle twice. */
		const HOTKEY_DEBOUNCE_MS = 250;
		//#endregion

		//#region host API helpers
		/** Timeout for one host call (audio transcribe can legitimately take a while). */
		const HOST_CALL_TIMEOUT_MS = 75_000;
		/** Local CPU inference runs ~0.3× realtime: a max-size (~4.7 min) recording
		 *  needs ~90 s, so the generic 75 s cap could cut a valid decode short. */
		const LOCAL_TRANSCRIBE_TIMEOUT_MS = 180_000;

		async function hostCall(body, timeoutMs) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs || HOST_CALL_TIMEOUT_MS);
			try {
				const res = await fetch(API_PREFIX, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					signal: controller.signal
				});
				let data = null;
				try { data = await res.json(); } catch { /* non-JSON */ }
				return data;
			} catch (error) {
				if (error && error.name === "AbortError") {
					const timeout = new Error("host call timed out");
					timeout.code = "host-timeout";
					throw timeout;
				}
				throw error;
			} finally {
				clearTimeout(timer);
			}
		}

		/**
		 * Transcribe and return { ok, text?, error? } — the caller needs the
		 * host's error code/message (asr-key-missing, asr-timeout, 401…), not
		 * just a boolean, so the status bar can show the real cause.
		 */
		async function transcribe(audioBase64, mimeType, language) {
			try {
				const data = await hostCall({ action: "transcribe", audio: audioBase64, mimeType, language: language || "" });
				if (data && data.ok === true && typeof data.text === "string") return { ok: true, text: data.text };
				const msg = data && data.error && typeof data.error.message === "string" ? data.error.message : "转写失败";
				return { ok: false, error: msg };
			} catch (error) {
				return { ok: false, error: error && error.code === "host-timeout" ? "请求超时" : (error && error.message ? error.message : "转写失败") };
			}
		}

		async function polish(text, provider, model) {
			try {
				const data = await hostCall({ action: "polish", text, provider, model });
				// Never lose the transcript: only accept a real polished string.
				return data && data.ok === true && typeof data.text === "string" ? data.text : text;
			} catch {
				// Host unreachable / aborted — keep the raw transcript.
				return text;
			}
		}

		async function listModels() {
			const data = await hostCall({ action: "list-models" });
			return data && data.ok === true && Array.isArray(data.value) ? data.value : [];
		}

		async function fetchSettings() {
			const data = await hostCall({ action: "get-settings" });
			return data && data.ok === true && data.value ? data.value : null;
		}

		async function saveSettings(patch) {
			const data = await hostCall({ action: "set-settings", patch });
			return data && data.ok === true;
		}
		//#endregion

		//#region settings read/write (localStorage mirror)
		function readJson(key, fallback) {
			try {
				const raw = window.localStorage.getItem(key);
				return raw === null ? fallback : JSON.parse(raw);
			} catch {
				return fallback;
			}
		}
		function writeJson(key, value) {
			try {
				window.localStorage.setItem(key, JSON.stringify(value));
			} catch {
				// storage unavailable
			}
		}

		function readHotkey() {
			const v = readJson(HOTKEY_KEY, "alt");
			return HOTKEYS.indexOf(v) >= 0 ? v : "alt";
		}
		/**
		 * Recognition engine:
		 *   "auto" (default) — use the local SenseVoice engine when its model is
		 *     ready, otherwise Web Speech; on a Web Speech network error, switch
		 *     to local automatically (downloads the model on first use). Zero
		 *     config, zero key, and immune to blocked Google / Edge regressions.
		 *   "web-speech" — browser built-in (Google/Microsoft backend).
		 *   "local" — host-side SenseVoice via sherpa-onnx (offline, private).
		 *   "cloud-asr" — OpenAI-compatible endpoint (requires an API key).
		 */
		function readEngine() {
			// One-time migration (v0.2): the pre-0.2.0 default was "web-speech";
			// upgrading users must get the new "auto" default, otherwise they
			// stay on Web Speech (broken on Edge Stable / blocked Google) with
			// no auto-fallback to the local engine.
			if (readJson(ENGINE_MIGRATED_KEY, false) !== true) {
				writeJson(ENGINE_KEY, "auto");
				writeJson(ENGINE_MIGRATED_KEY, true);
			}
			const v = readJson(ENGINE_KEY, "auto");
			return v === "web-speech" || v === "local" || v === "cloud-asr" || v === "auto" ? v : "auto";
		}

		/** Cached local-model readiness (refreshed at boot and after downloads). */
		let localReady = false;
		let localDownloading = false;

		/** Resolve the effective engine for the next recording. */
		function effectiveEngine() {
			const engine = readEngine();
			if (engine === "auto") return localReady ? "local" : "web-speech";
			return engine;
		}
		function readLanguage() {
			const v = readJson(LANGUAGE_KEY, "");
			return typeof v === "string" ? v : "";
		}
		function readPolishEnabled() {
			return readJson(POLISH_KEY, false) === true;
		}
		function readPolishModel() {
			const v = readJson(POLISH_MODEL_KEY, null);
			return v !== null && typeof v === "object" ? v : null; // { provider, model }
		}
		//#endregion

				//#region composer DOM helpers + draft channel
		/**
		 * DraftChannel: where the transcript goes.
		 *  - Preferred: the composer slot's inputActions.setDraft (injected by
		 *    the MicrophoneButton slot — realtime, cursor-aware, no DOM query).
		 *  - Fallback: direct textarea manipulation (hotkey path when the slot
		 *    has not mounted yet, or older DSH shells without the slot).
		 * The recorder code only talks to setDraftText(text) / draftText() —
		 * it never cares which backend is live.
		 */
		let draftChannel = null; // { setDraft(text), getDraft() } from the slot

		/** Called by the MicrophoneButton slot when it mounts. */
		function setDraftChannel(channel) {
			draftChannel = channel;
		}

		function draftText() {
			if (draftChannel && typeof draftChannel.getDraft === "function") {
				try { return draftChannel.getDraft(); } catch { /* fall through */ }
			}
			const ta = findComposerTextarea();
			return ta ? ta.value : "";
		}

		/** Write the full next draft (slot setDraft preferred, textarea fallback). */
		function setDraftText(text) {
			if (draftChannel && typeof draftChannel.setDraft === "function") {
				try { draftChannel.setDraft(text); return true; } catch { /* fall through */ }
			}
			const ta = findComposerTextarea();
			if (!ta) return false;
			ta.value = text;
			ta.dispatchEvent(new Event("input", { bubbles: true }));
			ta.focus();
			return true;
		}

		/** Find the composer textarea. CSS class name is a hashed DSH class (uV2eYG_input). */
		function findComposerTextarea() {
			// Primary: the input inside the composer card.
			const card = document.querySelector('[data-composer-card="true"]');
			if (card) {
				const ta = card.querySelector("textarea");
				if (ta) return ta;
			}
			// Fallback: any visible textarea that is not a settings input.
			const candidates = Array.from(document.querySelectorAll("textarea"));
			const visible = candidates.filter((el) => {
				const r = el.getBoundingClientRect();
				return r.width > 100 && r.height > 20 && el.offsetParent !== null;
			});
			// Prefer the one inside a composer-ish region.
			const composer = visible.find((el) => {
				const html = el.closest("[data-composer-card]") !== null || /composer/i.test((el.parentElement && el.parentElement.className) || "");
				return html;
			});
			return composer || visible[visible.length - 1] || null;
		}

		/** Insert text at the textarea's cursor (native setRangeText + input event). */
		function insertIntoComposer(textarea, text) {
			if (!textarea || !text) return false;
			try {
				const before = textarea.value;
				const start = textarea.selectionStart != null ? textarea.selectionStart : before.length;
				const end = textarea.selectionEnd != null ? textarea.selectionEnd : before.length;
				const sep = before.length > 0 && start > 0 && !/\s$/.test(before.slice(0, start)) ? " " : "";
				textarea.setRangeText(sep + text, start, end, "end");
				textarea.dispatchEvent(new Event("input", { bubbles: true }));
				textarea.focus();
				return true;
			} catch {
				// contenteditable fallback (unlikely for DSH's textarea composer)
				textarea.value = (textarea.value ? textarea.value + " " : "") + text;
				textarea.dispatchEvent(new Event("input", { bubbles: true }));
				return true;
			}
		}

		/**
		 * Insert a completed transcript into the composer. Tries the slot
		 * channel first (setDraft = full next draft, preserves draft), falls
		 * back to cursor insertion on the raw textarea.
		 */
		function insertTranscript(text) {
			if (!text) return false;
			if (draftChannel && typeof draftChannel.setDraft === "function") {
				try {
					const current = draftText();
					const sep = current && !/\s$/.test(current) ? " " : "";
					draftChannel.setDraft(current + sep + text);
					return true;
				} catch { /* fall through */ }
			}
			const ta = findComposerTextarea();
			return !!(ta && insertIntoComposer(ta, text));
		}
		//#endregion

		//#region recorder: Web Speech (browser built-in, zero config / zero key)
		/**
		 * Web Speech API (SpeechRecognition): Chrome/Edge built-in, no API key,
		 * audio handled by the browser. Start/stop maps exactly to our tap-Alt
		 * interaction. This is the default engine so the plugin works out of
		 * the box for users whose only credential is the DeepSeek API key
		 * (a text-model key cannot transcribe audio).
		 */
		const SpeechRecognitionCtor = typeof window !== "undefined"
			? (window.SpeechRecognition || window.webkitSpeechRecognition)
			: undefined;
		let recognition = null;
		let wsRecording = false;
		let wsFinalText = "";
		/** Draft snapshot when Web Speech recording began — interim results layer on top. */
		let wsDraftBase = "";

		function webSpeechSupported() {
			return typeof SpeechRecognitionCtor !== "undefined";
		}

		function startWebSpeech() {
			if (wsRecording) return false;
			if (!webSpeechSupported()) {
				setStatus("此浏览器不支持 Web Speech 识别（请用 Chrome/Edge）");
				return false;
			}
			try {
				recognition = new SpeechRecognitionCtor();
				// Baseline for realtime interim transcription: everything the
				// recognizer produces is layered ON TOP of the draft as it was
				// when recording began (never clobber the user's existing draft).
				wsDraftBase = draftText();
				recognition.continuous = true;
				// interimResults must be ON: with continuous=true, Chrome/Edge only
				// emit final results after a silence pause. If the user taps Alt to
				// stop mid-sentence, stop() drops the un-finalized speech and we'd
				// get an empty transcript. With interim on, onresult keeps the
				// latest hypothesis so we can fall back to it on stop.
				recognition.interimResults = true;
				recognition.lang = readLanguage() || "zh-CN";
				wsFinalText = "";
				wsLastInterim = "";
				pendingWsStop = false;
				wsError = null;
				recognition.onresult = (event) => {
					let interimChanged = false;
					for (let i = event.resultIndex; i < event.results.length; i++) {
						const result = event.results[i];
						if (result.isFinal) {
							wsFinalText += result[0].transcript;
							wsLastInterim = "";
							interimChanged = true;
						} else {
							// Keep the latest interim hypothesis so a mid-sentence
							// stop() can still recover what was spoken.
							wsLastInterim = result[0].transcript;
							interimChanged = true;
						}
					}
					// Realtime: stream the latest hypothesis into the composer
					// while the user is still talking (interim is transient —
					// the final transcript replaces it on stop).
					if (interimChanged && wsLastInterim) {
						const sep = wsDraftBase && !/\s$/.test(wsDraftBase) ? " " : "";
						setDraftText(wsDraftBase + sep + wsLastInterim);
					}
				};
				recognition.onerror = (event) => {
					// Record the failure so onend does not overwrite it with a
					// generic "no text" message. "aborted" is our own stop().
					if (event.error === "aborted") return;
					wsError = event.error || "unknown";
					if (event.error === "not-allowed" || event.error === "service-not-allowed") {
						setStatus("❌ 麦克风权限被拒绝（请在浏览器地址栏授予麦克风权限）", true);
					} else if (event.error === "no-speech") {
						setStatus("未检测到语音", true);
					} else if (event.error === "network") {
						// The browser's speech backend (Google/Microsoft) is
						// unreachable — common on mainland-China networks and on
						// Edge Stable (known regression). In "auto" mode, switch
						// to the local SenseVoice engine (zero key, offline).
						if (readEngine() === "auto") {
							void autoFallbackToLocal();
						} else {
							setStatus("❌ 浏览器语音识别不可用：识别服务需访问 Google/微软，当前网络无法连接。请到 设置 → 语音输入 切换「本地离线识别」或「云端 ASR」", true);
						}
					} else {
						setStatus("❌ 识别错误：" + event.error, true);
					}
				};
				recognition.onend = () => {
					// onend fires after every onresult has been delivered — this is
					// the ONLY safe point to read the final transcript. Reading it
					// right after recognition.stop() races the last results.
					const wasRecording = wsRecording;
					wsRecording = false;
					syncMicState();
					recognition = null;
					if (wsError !== null) {
						// A real failure already surfaced the cause — do not replace
						// it with finishWebSpeech's "未识别到文字".
						wsError = null;
						return;
					}
					if (wasRecording) {
						finishWebSpeech();
					} else if (!pendingWsStop) {
						// Unexpected end (silence timeout etc.) — surface it.
						setStatus("录音已结束（未检测到持续语音）", true);
					}
				};
				recognition.start();
				wsRecording = true;
				syncMicState();
				setStatus("🎙 录音中…（再按一次结束）", true);
				return true;
			} catch (error) {
				setStatus("❌ 启动识别失败：" + (error && error.message ? error.message : "未知错误"));
				return false;
			}
		}

		/** Set when the user tapped Alt to stop; onend consumes it. */
		let pendingWsStop = false;
		/** Non-null when the last recognition ended with an error (onend must not overwrite it). */
		let wsError = null;
		/** Latest interim hypothesis — fallback when stop() drops un-finalized speech. */
		let wsLastInterim = "";

		/** Read the final transcript, run optional polish, insert into composer. */
		function finishWebSpeech() {
			setStatus("⏳ 转写中…", true);
			// Prefer finalized text; fall back to the last interim hypothesis so a
			// mid-sentence stop() still recovers what the user said.
			let text = wsFinalText.trim();
			if (text === "") {
				text = (wsLastInterim || "").trim();
			}
			if (!text) {
				// Nothing recognised: roll back the realtime interim so the
				// composer is exactly as it was before recording.
				setDraftText(wsDraftBase);
				setStatus("未识别到文字（请靠近麦克风再说一次）", true);
				return;
			}
			// Optional polish through DSH's configured model.
			const polishEnabled = readPolishEnabled();
			const polishModel = readPolishModel();
			const insert = (finalText) => {
				// Real-time interim already wrote draftBase+interim — replace
				// that whole span with the final transcript (not append again).
				// wsDraftBase may legitimately be "" (recording from an empty
				// draft): appending via insertTranscript would duplicate the
				// interim text, so always rebuild from the baseline.
				if (draftChannel && typeof draftChannel.setDraft === "function") {
					try {
						draftChannel.setDraft(wsDraftBase + (wsDraftBase && !/\s$/.test(wsDraftBase) ? " " : "") + finalText);
						setStatus("✅ 已插入");
						return;
					} catch { /* fall through */ }
				}
				if (insertTranscript(finalText)) setStatus("✅ 已插入");
				else setStatus("❌ 未找到输入框", true);
			};
			if (polishEnabled && polishModel && polishModel.provider && polishModel.model) {
				// Persistent: polishing can take up to 30 s — a transient pill
				// fading after 2.6 s made it look like nothing was happening.
				setStatus("✨ 润色中…", true);
				// polish() never rejects, but keep a defensive catch so a bug can
				// never leave the status pill stuck or drop the transcript.
				void polish(text, polishModel.provider, polishModel.model).then(insert).catch(() => insert(text));
			} else {
				insert(text);
			}
		}

		function stopWebSpeech() {
			if (!wsRecording || !recognition) return;
			// Immediate feedback: the user tapped Alt again — show processing
			// right away instead of letting the status pill sit on "录音中".
			setStatus("⏳ 处理中…", true);
			pendingWsStop = true;
			try {
				recognition.stop();
			} catch {
				// already stopped — finish anyway
				pendingWsStop = false;
				wsRecording = false;
				finishWebSpeech();
			}
		}
		//#endregion

		//#region recorder (MediaRecorder, cloud-asr engine)
		let recorder = null;
		let recordingChunks = [];
		let recordingMimeType = "";
		let recordingStartTime = 0;
		let stream = null;
		let recording = false;
		/** Draft snapshot when MediaRecorder recording began (realtime preview base). */
		let recDraftBase = "";
		/** Realtime preview timer for the LOCAL engine (3s cadence). */
		let localPreviewTimer = null;

		async function startRecording() {
			if (recording) return false;
			if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
				setStatus("此浏览器不支持麦克风（需要 HTTPS 或 localhost）");
				return false;
			}
			try {
				stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			} catch (error) {
				setStatus("无法访问麦克风：" + (error && error.name ? error.name : "权限被拒绝"));
				return false;
			}
			recordingChunks = [];
			// Baseline for realtime preview (local engine): recorded text layers
			// on top of the draft as it was when recording began.
			recDraftBase = draftText();
			clearInterval(localPreviewTimer);
			localPreviewTimer = null;
			const preferred = ["audio/webm", "audio/mp4", "audio/ogg"];
			const mime = preferred.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) || "";
			recordingMimeType = mime || "audio/webm";
			try {
				recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
			} catch (error) {
				// MediaRecorder construction failed (unsupported mime / platform).
				// Release the microphone — otherwise the stream stays live and
				// the mic indicator never turns off.
				stream.getTracks().forEach((track) => track.stop());
				stream = null;
				setStatus("❌ 无法启动录音：" + (error && error.message ? error.message : "MediaRecorder 不可用"), true);
				return false;
			}
			recorder.ondataavailable = (event) => {
				if (event.data && event.data.size > 0) recordingChunks.push(event.data);
			};
			recorder.onstop = () => {
				const blob = new Blob(recordingChunks, { type: recordingMimeType });
				void finishRecording(blob);
			};
			recorder.start();
			recording = true;
			syncMicState();
			recordingStartTime = Date.now();
			// Realtime preview (local engine only): every 3s, transcribe what
			// has been recorded so far and stream the hypothesis into the
			// composer. Cloud/web-speech engines skip this (cost / redundancy).
			if (effectiveEngine() === "local" && !localPreviewTimer) {
				localPreviewTimer = setInterval(() => { void runLocalPreview(); }, 3000);
			}
			setStatus("🎙 录音中…（再按一次结束）", true);
			return true;
		}

		async function finishRecording(blob) {
			recording = false;
			syncMicState();
			clearInterval(localPreviewTimer);
			localPreviewTimer = null;
			if (stream) {
				stream.getTracks().forEach((track) => track.stop());
				stream = null;
			}
			if (blob.size < 200) {
				// Too short: roll back any realtime preview so stale text
				// does not stay in the composer as if it were final.
				if (recDraftBase !== undefined) setDraftText(recDraftBase);
				setStatus("录音太短，未转写");
				return;
			}
			setStatus("⏳ 转写中…", true);
			try {
				let result;
				if (effectiveEngine() === "local") {
					setStatus("⏳ 本地离线转写中…", true);
					result = await transcribeLocal(blob);
				} else {
					const reader = new FileReader();
					const base64 = await new Promise((resolve, reject) => {
						reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
						reader.onerror = reject;
						reader.readAsDataURL(blob);
					});
					const language = readLanguage();
					result = await transcribe(base64, blob.type || recordingMimeType, language);
				}
				if (!result.ok) {
					if (recDraftBase !== undefined) setDraftText(recDraftBase);
					setStatus("❌ 转写失败：" + (result.error || "请检查设置中的 ASR 配置"), true);
					return;
				}
				let text = result.text;
				// Optional polish through DSH's configured model.
				const polishEnabled = readPolishEnabled();
				const polishModel = readPolishModel();
				if (polishEnabled && polishModel && polishModel.provider && polishModel.model) {
					setStatus("✨ 润色中…", true);
					text = await polish(text, polishModel.provider, polishModel.model);
				}
				// Local engine: the realtime preview already wrote
				// recDraftBase+preview — replace that whole span (rebuild from
				// the baseline) instead of appending the final transcript on
				// top of the stale preview. Cloud/web-speech have no preview,
				// so plain append (insertTranscript) is correct there.
				if (effectiveEngine() === "local" && draftChannel && typeof draftChannel.setDraft === "function") {
					try {
						draftChannel.setDraft(recDraftBase + (recDraftBase && !/\s$/.test(recDraftBase) ? " " : "") + text);
						setStatus("✅ 已插入");
					} catch {
						if (insertTranscript(text)) setStatus("✅ 已插入");
						else setStatus("❌ 未找到输入框");
					}
				} else if (insertTranscript(text)) {
					setStatus("✅ 已插入");
				} else {
					setStatus("❌ 未找到输入框");
				}
			} catch (error) {
				if (recDraftBase !== undefined) setDraftText(recDraftBase);
				setStatus("❌ 转写失败：" + (error && error.message ? error.message : "未知错误"));
			}
		}

		function stopRecording() {
			if (!recording || !recorder) return;
			clearInterval(localPreviewTimer);
			localPreviewTimer = null;
			try {
				recorder.stop();
			} catch {
				recording = false;
				syncMicState();
				if (stream) {
					stream.getTracks().forEach((track) => track.stop());
					stream = null;
				}
				setStatus("已停止", true);
			}
		}

		//#region local engine (SenseVoice via host sherpa-onnx — zero key, offline)

		/** Decode a recording blob to 16 kHz mono float32 PCM (browser-side). */
		function blobToPcm16k(blob) {
			return new Promise(async (resolve, reject) => {
				// Hard timeout so a stuck decode can never leave the status pill
				// on "本地离线转写中…" forever.
				const timer = setTimeout(() => {
					reject(new Error("音频解码超时（请重试，或缩短录音）"));
				}, 30000);
				try {
					const Ctx = window.AudioContext || window.webkitAudioContext;
					if (!Ctx) { clearTimeout(timer); reject(new Error("此浏览器不支持音频解码")); return; }
					const ctx = new Ctx();
					// decodeAudioData takes an ArrayBuffer — passing a Blob is
					// non-standard and can silently never call back in Edge.
					const arrayBuffer = await blob.arrayBuffer();
					const buffer = await ctx.decodeAudioData(arrayBuffer);
					const src = buffer.getChannelData(0);
					const targetRate = 16000;
					let out;
					if (buffer.sampleRate === targetRate) {
						out = new Float32Array(src);
					} else {
						const ratio = buffer.sampleRate / targetRate;
						out = new Float32Array(Math.round(src.length / ratio));
						for (let i = 0; i < out.length; i++) {
							const pos = i * ratio;
							const i0 = Math.floor(pos);
							const i1 = Math.min(i0 + 1, src.length - 1);
							const frac = pos - i0;
							out[i] = src[i0] + (src[i1] - src[i0]) * frac;
						}
					}
					clearTimeout(timer);
					ctx.close().catch(() => {});
					resolve(out);
				} catch (error) {
					clearTimeout(timer);
					reject(error);
				}
			});
		}

		/** Float32Array -> little-endian base64 (bytes), for the host route. */
		function f32ToBase64(samples) {
			const bytes = new Uint8Array(samples.length * 4);
			const view = new DataView(bytes.buffer);
			for (let i = 0; i < samples.length; i++) view.setFloat32(i * 4, samples[i], true);
			let binary = "";
			const chunk = 0x8000;
			for (let i = 0; i < bytes.length; i += chunk) {
				binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
			}
			return btoa(binary);
		}

		/** Query the host for local-model status and cache the readiness flag. */
		async function refreshLocalStatus() {
			try {
				const data = await hostCall({ action: "local-status" });
				if (data && data.ok === true && data.value) {
					localReady = data.value.modelReady === true;
					localDownloading = data.value.downloading === true;
					return data.value;
				}
			} catch {
				// host unreachable — keep last known state
			}
			return null;
		}

		/** In-flight ensure promise: a second Alt tap while the model is still
		 *  downloading must join the ongoing poll, not start a duplicate loop
		 *  (the old localDownloading flag was write-only and never guarded). */
		let localModelPromise = null;

		/** Start the model download and poll until ready (or give up). */
		async function ensureLocalModel() {
			if (localModelPromise) return localModelPromise;
			localModelPromise = ensureLocalModelInner();
			try {
				return await localModelPromise;
			} finally {
				localModelPromise = null;
			}
		}

		async function ensureLocalModelInner() {
			localDownloading = true;
			try {
				const start = await hostCall({ action: "local-download" });
				if (!start || start.ok !== true) {
					localDownloading = false;
					return false;
				}
				for (let i = 0; i < 200; i++) {
					await new Promise((r) => setTimeout(r, 3000));
					const status = await refreshLocalStatus();
					if (status && status.modelReady) return true;
					if (status && status.error) {
						localDownloading = false;
						setStatus("❌ 本地识别模型下载失败：" + (status.error || "请检查网络"), true);
						return false;
					}
				}
			} finally {
				localDownloading = false;
			}
			setStatus("❌ 本地识别模型下载超时，请稍后重试", true);
			return false;
		}

		/** Transcribe a recording blob with the LOCAL engine. */
		async function transcribeLocal(blob) {
			try {
				const samples = await blobToPcm16k(blob);
				if (samples.length === 0) return { ok: false, error: "未解码到有效音频（请重试）" };
				const audio = f32ToBase64(samples);
				const data = await hostCall({ action: "local-transcribe", audio, sampleRate: 16000 }, LOCAL_TRANSCRIBE_TIMEOUT_MS);
				if (data && data.ok === true && typeof data.text === "string") return { ok: true, text: data.text };
				const msg = data && data.error && typeof data.error.message === "string" ? data.error.message : "本地转写失败";
				return { ok: false, error: msg };
			} catch (error) {
				return { ok: false, error: error && error.message ? error.message : "本地转写失败" };
			}
		}

		/** In-flight guard: a slow preview must not stack another request. */
		let localPreviewRunning = false;

		/**
		 * Realtime preview for the LOCAL engine: transcribe what has been
		 * recorded so far and stream the hypothesis into the composer. Runs on
		 * a 3s cadence while recording; errors are silent (the final
		 * transcription on stop is authoritative).
		 */
		async function runLocalPreview() {
			if (!recording || !recorder || localPreviewRunning) return;
			localPreviewRunning = true;
			try {
				const blob = new Blob(recordingChunks, { type: recordingMimeType });
				if (blob.size < 200) return;
				const result = await transcribeLocal(blob);
				if (!recording || !result.ok || !result.text) return;
				// Layer the latest hypothesis on top of the draft baseline
				// (never clobber the user's existing draft).
				const sep = recDraftBase && !/\s$/.test(recDraftBase) ? " " : "";
				setDraftText(recDraftBase + sep + result.text);
			} catch { /* preview is best-effort */ }
			finally {
				localPreviewRunning = false;
			}
		}

		/** Start local recording: ensure the model first, then reuse MediaRecorder. */
		async function startLocalRecording() {
			if (!localReady) {
				setStatus("⏳ 首次使用需下载本地识别模型（约 230MB，只需一次）…", true);
				const ok = await ensureLocalModel();
				if (!ok) return false;
				setStatus("✅ 本地识别模型就绪，请再按一次 Alt 开始说话", true);
				return false; // user presses again to start
			}
			return startRecording();
		}
		//#endregion

		/** Reflect recording/busy state on window so the mic button can read it. */
		function syncMicState() {
			window.__voiceScribeRecording = wsRecording || recording;
			window.__voiceScribeBusy = false;
		}

		function toggleRecording() {
			const engine = effectiveEngine();
			if (engine === "web-speech") {
				if (wsRecording) stopWebSpeech();
				else void startWebSpeech();
				syncMicState();
				return;
			}
			if (engine === "local") {
				if (recording) stopRecording();
				else void startLocalRecording();
				syncMicState();
				return;
			}
			if (recording) stopRecording();
			else void startRecording();
			syncMicState();
		}
		//#endregion

		//#region status bar
		let statusEl = null;
		function ensureStatusEl() {
			if (statusEl && document.body.contains(statusEl)) return statusEl;
			statusEl = document.createElement("div");
			statusEl.id = "dsh-voice-input-status";
			statusEl.style.cssText = [
				"position:fixed",
				"left:50%",
				"top:16px",
				"transform:translateX(-50%)",
				"z-index:99999",
				"background:rgba(20,20,26,0.92)",
				"color:#f4f5f7",
				"border:1px solid rgba(255,255,255,0.14)",
				"border-radius:999px",
				"padding:6px 16px",
				"font:13px/1.5 system-ui,sans-serif",
				"box-shadow:0 4px 24px rgba(0,0,0,0.35)",
				"transition:opacity .15s",
				"pointer-events:none"
			].join(";");
			statusEl.setAttribute("role", "status");
			statusEl.setAttribute("aria-live", "polite");
			statusEl.setAttribute("aria-atomic", "true");
			document.body.appendChild(statusEl);
			return statusEl;
		}
		let statusTimer = null;
		/**
		 * Show a status pill. Persistent statuses (recording / transcribing)
		 * stay visible until a non-persistent status replaces them; transient
		 * statuses (success / error) auto-fade after STATUS_FADE_MS.
		 * @param {string} text - status text.
		 * @param {boolean} [persistent=false] - keep visible (no auto-fade).
		 */
		function setStatus(text, persistent) {
			const el = ensureStatusEl();
			el.textContent = text;
			el.style.opacity = "1";
			if (statusTimer) clearTimeout(statusTimer);
			if (!persistent) {
				statusTimer = setTimeout(() => { el.style.opacity = "0"; }, 2600);
			}
		}
		//#endregion

		//#region hotkey handling
		/** Match the configured hotkey from a keydown event. */
		function matchesHotkey(event, hotkey) {
			if (hotkey === "alt") {
				return event.key === "Alt" && !event.ctrlKey && !event.metaKey && !event.shiftKey;
			}
			if (hotkey === "alt-space") {
				// Alt+Space: space with altKey held (ignore repeat keyups)
				return event.key === " " && event.altKey && !event.ctrlKey && !event.metaKey;
			}
			return false;
		}

		/** Is the element an editable field (input / textarea / contenteditable)? */
		function isEditableElement(el) {
			if (!el) return false;
			const tag = el.tagName;
			return tag === "TEXTAREA" || tag === "INPUT" || el.isContentEditable === true;
		}

		/** Is the editable element the composer (or inside it)? */
		function isComposerEditable(el) {
			const ta = findComposerTextarea();
			return ta !== null && (el === ta || ta.contains(el));
		}

		let lastToggleAt = 0;
		function onKeyDown(event) {
			const hotkey = readHotkey();
			if (!matchesHotkey(event, hotkey)) return;
			if (event.repeat) return; // holding Alt+Space must not re-toggle
			// Never hijack Alt while the user is typing in a non-composer field
			// (search box, settings inputs…) — toggling recording there is a
			// surprise, and Alt is often needed for input methods.
			const active = document.activeElement;
			if (active && isEditableElement(active) && !isComposerEditable(active)) return;
			// Debounce double-toggles.
			const now = Date.now();
			if (now - lastToggleAt < HOTKEY_DEBOUNCE_MS) return;
			lastToggleAt = now;
			event.preventDefault();
			event.stopPropagation();
			toggleRecording();
		}

		function mountHotkey() {
			window.addEventListener("keydown", onKeyDown, true);
		}
		function unmountHotkey() {
			window.removeEventListener("keydown", onKeyDown, true);
		}
		//#endregion

		//#region boot
		function boot() {
			mountHotkey();
			// Pre-fetch settings so the first transcribe has the host defaults in view (harmless).
			void fetchSettings().catch(() => {});
			// Warm the local-model readiness flag so "auto" can route correctly
			// on the very first Alt tap.
			void refreshLocalStatus().catch(() => {});
		}

		/** Auto-fallback: browser speech is unreachable → prep the local engine. */
		async function autoFallbackToLocal() {
			setStatus("🔁 浏览器识别不可用，正在切换本地离线识别（首次使用需下载模型约 230MB，只需一次）…", true);
			if (localReady) {
				setStatus("🔁 已切换到本地离线识别，请再按一次 Alt", true);
				return;
			}
			const ok = await ensureLocalModel();
			if (ok) setStatus("✅ 本地识别模型已就绪，请再按一次 Alt 开始说话", true);
		}
		//#endregion

		//#region dsh-voice-scribe: settings UI
		/** The settings section's locale namespace. */
		const SETTINGS_NS = "settings.voiceScribe";
		/** Settings section id used for slots registration. */
		const SETTINGS_SECTION_ID = "voice-scribe";

		/** Settings row dictionaries — nested per-locale (the shape DSH's locale service expects). */
		const settingsLocale = {
			zh: {
				"engine.title": "识别引擎",
				"engine.auto": "自动（推荐）：本地离线识别优先，浏览器识别不可用时自动切换",
				"engine.web-speech": "浏览器内置识别（Web Speech）",
				"engine.local": "本地离线识别（SenseVoice，零配置、零 key、不出本机）",
				"engine.cloud-asr": "云端 ASR（OpenAI 兼容，需配置 API key）",
				"local.ready": "✅ 本地识别模型已就绪",
				"local.downloading": "⏳ 本地识别模型下载中…",
				"local.missing": "ℹ️ 本地识别模型未下载（首次使用自动下载约 230MB，只需一次）",
				"language.title": "识别语言",
				"language.auto": "自动（跟随系统）",
				"language.note": "支持中/英/粤/日/韩；本地离线识别会自动检测语言，此选项作用于浏览器与云端识别。",
				"hotkey.title": "热键",
				"hotkey.alt": "Alt（点按切换）",
				"hotkey.alt-space": "Alt + 空格",
				"polish.title": "润色（复用 DSH 模型）",
				"polish.on": "开启",
				"polish.off": "关闭",
				"hint": "润色开启后，转写文本会通过 DSH 已配置的模型清理口头禅、补标点；失败时保留原始转写。",
				"cloud.title": "云端 ASR 配置（服务端保存，key 不进浏览器）",
				"cloud.url": "接口地址 (Base URL)",
				"cloud.model": "模型 (Model)",
				"cloud.key": "API Key",
				"cloud.keySet": "已配置（留空保持不变）",
				"cloud.save": "保存配置",
				"cloud.saved": "✅ 配置已保存",
				"cloud.failed": "❌ 保存失败",
				"cloud.placeholderUrl": "https://api.groq.com/openai/v1/audio/transcriptions",
				"cloud.placeholderModel": "whisper-large-v3",
				"cloud.urlInvalid": "❌ 接口地址需以 http(s):// 开头",
				"cloud.clearKey": "清除已保存 Key",
				"cloud.keyCleared": "✅ 已清除",
				"cloud.providerTitle": "云端服务链（按顺序尝试，失败自动切换下一个）",
				"cloud.addProvider": "+ 添加服务",
				"cloud.removeProvider": "移除",
				"cloud.providerPlaceholderUrl": "https://api.groq.com/openai/v1/audio/transcriptions",
				"cloud.providerPlaceholderModel": "whisper-large-v3",
				"mic.tooltip": "语音输入（Alt）",
				"mic.recording": "录音中…点击停止",
				"mic.transcribing": "转写中…",
				"mic.unavailable": "语音输入暂不可用",
				"warn.wsUnsupported": "⚠️ 当前浏览器不支持 Web Speech，请用 Chrome/Edge，或切换到云端引擎",
				"warn.wsChrome": "⚠️ Chrome 的浏览器识别依赖 Google 服务，国内网络通常不可用。建议使用 Edge（微软服务，国内可用）或切换「云端 ASR」",
				"warn.noKey": "⚠️ 尚未配置 API key，云端转写会失败"
			},
			en: {
				"engine.title": "Recognition engine",
				"engine.auto": "Auto (recommended): local offline first, falls back when Web Speech is unavailable",
				"engine.web-speech": "Browser Web Speech",
				"engine.local": "Local offline (SenseVoice, zero config, audio never leaves the machine)",
				"engine.cloud-asr": "Cloud ASR (OpenAI-compatible, requires API key)",
				"local.ready": "✅ Local model ready",
				"local.downloading": "⏳ Local model downloading…",
				"local.missing": "ℹ️ Local model not downloaded (auto-downloads ~230MB on first use, once)",
				"language.title": "Recognition language",
				"language.auto": "Auto (follow system)",
				"language.note": "Chinese / English / Cantonese / Japanese / Korean supported. The local offline engine auto-detects the language; this choice applies to browser and cloud recognition.",
				"hotkey.title": "Hotkey",
				"hotkey.alt": "Alt (tap to toggle)",
				"hotkey.alt-space": "Alt + Space",
				"polish.title": "Polish (reuse DSH model)",
				"polish.on": "On",
				"polish.off": "Off",
				"hint": "When on, the transcript is cleaned (fillers removed, punctuation fixed) by a DSH-configured model; the raw transcript is kept if polishing fails.",
				"cloud.title": "Cloud ASR config (stored server-side; key never enters the browser)",
				"cloud.url": "Base URL",
				"cloud.model": "Model",
				"cloud.key": "API Key",
				"cloud.keySet": "Configured (leave blank to keep)",
				"cloud.save": "Save config",
				"cloud.saved": "✅ Config saved",
				"cloud.failed": "❌ Save failed",
				"cloud.placeholderUrl": "https://api.groq.com/openai/v1/audio/transcriptions",
				"cloud.placeholderModel": "whisper-large-v3",
				"cloud.urlInvalid": "❌ Base URL must start with http(s)://",
				"cloud.clearKey": "Clear saved key",
				"cloud.keyCleared": "✅ Cleared",
				"cloud.providerTitle": "Cloud provider chain (tried in order, auto-fails-over)",
				"cloud.addProvider": "+ Add provider",
				"cloud.removeProvider": "Remove",
				"cloud.providerPlaceholderUrl": "https://api.groq.com/openai/v1/audio/transcriptions",
				"cloud.providerPlaceholderModel": "whisper-large-v3",
				"mic.tooltip": "Voice input (Alt)",
				"mic.recording": "Recording… click to stop",
				"mic.transcribing": "Transcribing…",
				"mic.unavailable": "Voice input unavailable",
				"warn.wsUnsupported": "⚠️ Web Speech is unsupported in this browser — use Chrome/Edge or switch to the cloud engine.",
				"warn.wsChrome": "⚠️ Chrome's Web Speech relies on Google's service, usually unreachable in mainland-China networks. Use Edge (Microsoft service, works) or switch to cloud ASR.",
				"warn.noKey": "⚠️ No API key configured — cloud transcription will fail."
			}
		};

		/** Small labelled select row. */
		function SelectRow({ label, value, options, onChange }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				style: { display: "flex", alignItems: "center", gap: "10px", padding: "8px 0" },
				children: [
					(0, react_jsx_runtime.jsx)("span", {
						style: { flex: "1", color: "var(--dsw-alias-label-primary)", fontSize: "13px" },
						children: label
					}),
					(0, react_jsx_runtime.jsx)("select", {
						value: value,
						onChange: (event) => onChange(event.target.value),
						style: {
							background: "var(--dsw-alias-bg-layer-1)",
							color: "var(--dsw-alias-label-primary)",
							border: "1px solid var(--dsw-alias-border-l2)",
							borderRadius: "8px",
							padding: "4px 8px",
							fontSize: "13px",
							maxWidth: "260px"
						},
						children: options.map((opt) => (0, react_jsx_runtime.jsx)("option", { value: opt.value, children: opt.label }, opt.value))
					})
				]
			});
		}

		/** The settings section shell: renders the registered items. */
		function VoiceScribeSection({ renderSlot }) {
			return (0, react_jsx_runtime.jsx)("div", {
				style: { display: "flex", flexDirection: "column", gap: "12px", padding: "16px 0" },
				children: renderSlot("settings.voiceScribe.item", {})
			});
		}

		/** One labelled text input row (for the cloud-ASR config). */
		function TextRow({ label, value, placeholder, onChange, type }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				style: { display: "flex", alignItems: "center", gap: "10px", padding: "6px 0" },
				children: [
					(0, react_jsx_runtime.jsx)("span", {
						style: { flex: "0 0 150px", color: "var(--dsw-alias-label-primary)", fontSize: "13px" },
						children: label
					}),
					(0, react_jsx_runtime.jsx)("input", {
						type: type || "text",
						value: value,
						placeholder: placeholder || "",
						onChange: (event) => onChange(event.target.value),
						style: {
							flex: "1",
							minWidth: "200px",
							background: "var(--dsw-alias-bg-layer-1)",
							color: "var(--dsw-alias-label-primary)",
							border: "1px solid var(--dsw-alias-border-l2)",
							borderRadius: "8px",
							padding: "6px 10px",
							fontSize: "13px",
							boxSizing: "border-box"
						}
					})
				]
			});
		}

		/** The main settings row: engine / language / hotkey / polish toggle + cloud-ASR config. */
		function VoiceScribeRow({ t }) {
			// Local re-render tick so changing a select immediately updates the UI
			// (settings live in localStorage; the row re-reads them on each render).
			const [, forceRender] = _react.useState(0);
			const engine = readEngine();
			const language = readLanguage();
			const hotkey = readHotkey();
			const polishOn = readPolishEnabled();
			const bump = () => forceRender((n) => n + 1);

			// Cloud-ASR config state: an ordered provider chain (tried in order,
			// fail-over to the next on error). Loaded from host on mount.
			const [providers, setProviders] = _react.useState([{ url: "", model: "", key: "", hasKey: false }]);
			const [cloudStatus, setCloudStatus] = _react.useState("");
			// Local offline engine status (model ready / downloading / missing).
			const [localInfo, setLocalInfo] = _react.useState(null);

			_react.useEffect(() => {
				let cancelled = false;
				void hostCall({ action: "local-status" }).then((data) => {
					if (cancelled || !(data && data.ok === true && data.value)) return;
					setLocalInfo(data.value);
					if (typeof data.value.modelReady === "boolean") localReady = data.value.modelReady;
					if (typeof data.value.downloading === "boolean") localDownloading = data.value.downloading;
					if (data.value.downloading === true) {
						// Poll while the first-use model download is running.
						let tries = 0;
						const timer = setInterval(() => {
							tries++;
							void hostCall({ action: "local-status" }).then((d2) => {
								if (cancelled) { clearInterval(timer); return; }
								if (d2 && d2.ok === true && d2.value) {
									setLocalInfo(d2.value);
									localReady = d2.value.modelReady === true;
									if (d2.value.modelReady === true || d2.value.error) clearInterval(timer);
								}
							}).catch(() => {});
							if (tries > 120) clearInterval(timer);
						}, 3000);
					}
				}).catch(() => {});
				void fetchSettings().then((value) => {
					if (cancelled || !value) return;
					if (Array.isArray(value.providers) && value.providers.length > 0) {
						setProviders(value.providers.map((p) => ({
							url: (p && typeof p.url === "string") ? p.url : "",
							model: (p && typeof p.model === "string") ? p.model : "",
							key: "",
							hasKey: !!(p && p.hasKey === true)
						})));
					} else {
						// Back-compat: host without providers view → single legacy group.
						setProviders([{
							url: typeof value.asrUrl === "string" ? value.asrUrl : "",
							model: typeof value.asrModel === "string" ? value.asrModel : "",
							key: "",
							hasKey: value.hasKey === true
						}]);
					}
					// Keep the localStorage language in sync with the host default
					// when the user has not chosen one yet.
					if (typeof value.language === "string" && value.language !== "" && readLanguage() === "") {
						writeJson(LANGUAGE_KEY, value.language);
						bump();
					}
				}).catch(() => {});
				return () => { cancelled = true; };
			}, []);

			/** Update one field of the provider at index i. */
			const updateProvider = (i, field, value) => {
				setProviders((prev) => prev.map((p, idx) => idx === i ? { ...p, [field]: value } : p));
			};

			const addProvider = () => {
				setProviders((prev) => [...prev, { url: "", model: "", key: "", hasKey: false }]);
			};

			const removeProvider = (i) => {
				setProviders((prev) => prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i));
			};

			const saveCloud = () => {
				setCloudStatus("");
				// Validate every URL; drop empty rows.
				const chain = [];
				for (const p of providers) {
					const url = (p.url || "").trim();
					if (url === "") continue;
					if (!/^https?:\/\//i.test(url)) {
						setCloudStatus(t("cloud.urlInvalid"));
						return;
					}
					const row = { url, model: (p.model || "").trim() };
					if ((p.key || "").trim() !== "") row.key = p.key.trim();
					chain.push(row);
				}
				if (chain.length === 0) {
					setCloudStatus(t("cloud.urlInvalid"));
					return;
				}
				void saveSettings({ asrProviders: chain }).then((ok) => {
					setCloudStatus(ok ? t("cloud.saved") : t("cloud.failed"));
					if (ok) {
						// Rebuild the edited rows with hasKey from the source
						// of truth: any row that had a key before the save, or
						// received a freshly typed one. (The host keeps old
						// keys for rows saved with an empty key field.)
						setProviders((prev) => {
							const byUrl = new Map(chain.map((c, idx) => [c.url, { c, idx }]));
							return prev.map((p, idx) => {
								const match = byUrl.get((p.url || "").trim());
								const saved = match && match.c ? match.c : null;
								return {
									url: saved ? saved.url : p.url,
									model: saved ? saved.model : p.model,
									key: "",
									hasKey: p.hasKey || !!(saved && saved.key)
								};
							}).filter((p) => p.url !== "");
						});
					}
					bump();
				}).catch(() => {
					setCloudStatus(t("cloud.failed"));
					bump();
				});
			};

			/** Remove the stored ASR keys on the host — keep url/model rows. */
			const clearCloudKey = () => {
				setCloudStatus("");
				// Preserve every row's url+model, blank only the keys (host
				// deletes a key when its string is "" — see set-settings).
				const chain = providers
					.map((p) => ({ url: (p.url || "").trim(), model: (p.model || "").trim(), key: "" }))
					.filter((p) => p.url !== "");
				void saveSettings({ asrProviders: chain }).then((ok) => {
					setCloudStatus(ok ? t("cloud.keyCleared") : t("cloud.failed"));
					if (ok) {
						setProviders((prev) => prev.map((p) => ({ ...p, key: "", hasKey: false })));
						bump();
					}
				}).catch(() => {
					setCloudStatus(t("cloud.failed"));
					bump();
				});
			};

			// Engine-specific inline warning (unsupported Web Speech / missing key).
			// Chrome's Web Speech routes to Google (unreachable on mainland-China
			// networks); Edge routes to Microsoft (works). Steer Chrome users away.
			const isChrome = typeof navigator !== "undefined"
				&& /Chrome\//.test(navigator.userAgent || "")
				&& !/Edg\//.test(navigator.userAgent || "");
			const engineWarn = engine === "web-speech"
				? (webSpeechSupported()
					? (isChrome ? t("warn.wsChrome") : "")
					: t("warn.wsUnsupported"))
				// Only the cloud engine needs an API key — warning about a
				// missing key on auto/local was plain wrong (both are keyless).
				: (engine === "cloud-asr" ? (cloudHasKey ? "" : t("warn.noKey")) : "");

			const children = [
				(0, react_jsx_runtime.jsx)(SelectRow, {
					label: t("engine.title"),
					value: engine,
					options: [
						{ value: "auto", label: t("engine.auto") },
						{ value: "local", label: t("engine.local") },
						{ value: "web-speech", label: t("engine.web-speech") },
						{ value: "cloud-asr", label: t("engine.cloud-asr") }
					],
					onChange: (v) => { writeJson(ENGINE_KEY, v); bump(); }
				}),
				(engine === "local" || engine === "auto") ? (0, react_jsx_runtime.jsx)("div", {
					style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: "18px", padding: "2px 0" },
					children: localInfo && localInfo.modelReady
						? t("local.ready")
						: (localInfo && localInfo.downloading
							? t("local.downloading") + (localInfo.progress && localInfo.progress.total > 0
								? " " + Math.min(100, Math.round(100 * localInfo.progress.done / localInfo.progress.total)) + "%"
								: "")
							: t("local.missing"))
				}) : null,
				(0, react_jsx_runtime.jsx)(SelectRow, {
					label: t("language.title"),
					value: language,
					options: [
						{ value: "", label: t("language.auto") },
						{ value: "zh-CN", label: "普通话 (zh-CN)" },
						{ value: "en-US", label: "English (en-US)" },
						{ value: "yue-Hant-HK", label: "粤语 (Cantonese)" },
						{ value: "ja-JP", label: "日本語 (ja-JP)" },
						{ value: "ko-KR", label: "한국어 (ko-KR)" }
					],
					onChange: (v) => { writeJson(LANGUAGE_KEY, v); bump(); }
				}),
				(0, react_jsx_runtime.jsx)("div", {
					style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px", padding: "0 0 2px" },
					children: t("language.note")
				}),
				(0, react_jsx_runtime.jsx)(SelectRow, {
					label: t("hotkey.title"),
					value: hotkey,
					options: [
						{ value: "alt", label: t("hotkey.alt") },
						{ value: "alt-space", label: t("hotkey.alt-space") }
					],
					onChange: (v) => { writeJson(HOTKEY_KEY, v); bump(); }
				}),
				(0, react_jsx_runtime.jsx)(SelectRow, {
					label: t("polish.title"),
					value: polishOn ? "on" : "off",
					options: [
						{ value: "off", label: t("polish.off") },
						{ value: "on", label: t("polish.on") }
					],
					onChange: (v) => { writeJson(POLISH_KEY, v === "on"); bump(); }
				})
			];

			// Cloud-ASR config block: an ordered provider chain (each row is
			// tried in order; on error the host falls through to the next).
			if (engine === "cloud-asr") {
				children.push(
					(0, react_jsx_runtime.jsxs)("div", {
						style: {
							marginTop: "10px",
							padding: "12px",
							border: "1px solid var(--dsw-alias-border-l2)",
							borderRadius: "10px",
							display: "flex",
							flexDirection: "column",
							gap: "4px"
						},
						children: [
							(0, react_jsx_runtime.jsx)("div", {
								style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", marginBottom: "6px" },
								children: t("cloud.providerTitle")
							}),
							providers.map((p, i) => (0, react_jsx_runtime.jsxs)("div", {
								style: { display: "flex", flexDirection: "column", gap: "2px", padding: "8px", border: "1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.06))", borderRadius: "8px", marginBottom: "6px" },
								children: [
									(0, react_jsx_runtime.jsx)("div", {
										style: { display: "flex", alignItems: "center", gap: "8px" },
										children: [
											(0, react_jsx_runtime.jsx)("span", {
												style: { flex: "0 0 24px", color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", fontWeight: "600" },
												children: "#" + (i + 1)
											}),
											(0, react_jsx_runtime.jsx)("input", {
												type: "text",
												value: p.url,
												placeholder: t("cloud.providerPlaceholderUrl"),
												onChange: (ev) => updateProvider(i, "url", ev.target.value),
												style: {
													flex: "1",
													minWidth: "160px",
													background: "var(--dsw-alias-bg-layer-1)",
													color: "var(--dsw-alias-label-primary)",
													border: "1px solid var(--dsw-alias-border-l2)",
													borderRadius: "8px",
													padding: "6px 10px",
													fontSize: "13px",
													boxSizing: "border-box"
												}
											}),
											providers.length > 1 ? (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												onClick: () => removeProvider(i),
												style: {
													background: "transparent",
													color: "var(--dsw-alias-label-secondary)",
													border: "1px solid var(--dsw-alias-border-l2)",
													borderRadius: "8px",
													padding: "4px 10px",
													fontSize: "12px",
													cursor: "pointer",
													flex: "0 0 auto"
												},
												children: t("cloud.removeProvider")
											}) : null
										]
									}),
									(0, react_jsx_runtime.jsxs)("div", {
										style: { display: "flex", alignItems: "center", gap: "8px" },
										children: [
											(0, react_jsx_runtime.jsx)("input", {
												type: "text",
												value: p.model,
												placeholder: t("cloud.providerPlaceholderModel"),
												onChange: (ev) => updateProvider(i, "model", ev.target.value),
												style: {
													flex: "1",
													minWidth: "120px",
													background: "var(--dsw-alias-bg-layer-1)",
													color: "var(--dsw-alias-label-primary)",
													border: "1px solid var(--dsw-alias-border-l2)",
													borderRadius: "8px",
													padding: "6px 10px",
													fontSize: "13px",
													boxSizing: "border-box"
												}
											}),
											(0, react_jsx_runtime.jsx)("input", {
												type: "password",
												value: p.key,
												placeholder: p.hasKey ? t("cloud.keySet") : t("cloud.key"),
												onChange: (ev) => updateProvider(i, "key", ev.target.value),
												style: {
													flex: "1",
													minWidth: "120px",
													background: "var(--dsw-alias-bg-layer-1)",
													color: "var(--dsw-alias-label-primary)",
													border: "1px solid var(--dsw-alias-border-l2)",
													borderRadius: "8px",
													padding: "6px 10px",
													fontSize: "13px",
													boxSizing: "border-box"
												}
											})
										]
									})
								]
							}, i)),
							(0, react_jsx_runtime.jsxs)("div", {
								style: { display: "flex", alignItems: "center", gap: "10px", marginTop: "6px" },
								children: [
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: addProvider,
										style: {
											background: "transparent",
											color: "var(--dsw-alias-label-secondary)",
											border: "1px dashed var(--dsw-alias-border-l2)",
											borderRadius: "8px",
											padding: "6px 12px",
											fontSize: "13px",
											cursor: "pointer"
										},
										children: t("cloud.addProvider")
									}),
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: saveCloud,
										style: {
											background: "var(--dsw-alias-button-info-fill, #5e6ad2)",
											color: "#fff",
											border: "none",
											borderRadius: "8px",
											padding: "6px 14px",
											fontSize: "13px",
											cursor: "pointer"
										},
										children: t("cloud.save")
									}),
									cloudStatus ? (0, react_jsx_runtime.jsx)("span", {
										style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px" },
										children: cloudStatus
									}) : null
								]
							})
						]
					})
				);
			}

			if (engineWarn) {
				children.push((0, react_jsx_runtime.jsx)("div", {
					style: { color: "var(--dsw-alias-label-warning, #d97706)", fontSize: "12px", lineHeight: "18px" },
					children: engineWarn
				}));
			}

			children.push((0, react_jsx_runtime.jsx)("div", {
				style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px" },
				children: t("hint")
			}));

			return (0, react_jsx_runtime.jsx)("div", {
				style: { display: "flex", flexDirection: "column", gap: "2px" },
				children: children
			});
		}

		/**
		 * Microphone button: registered into the composer tool row
		 * (conversation.input.right). Clicking toggles recording; while
		 * mounted it hands the composer's setDraft to the draft channel so
		 * realtime interim results can stream into the composer.
		 */
		function MicrophoneButton({ input, inputActions, t: injectedT }) {
			const t = typeof injectedT === "function" ? injectedT : (key) => key;
			const [recState, setRecState] = _react.useState({ recording: false, busy: false });
			_react.useEffect(() => {
				// Adopt the composer's draft channel (getDraft/setDraft) so the
				// recorder code can write realtime transcripts without touching
				// the DOM. Set on every render so a changed session re-adopts.
				if (inputActions && typeof inputActions.setDraft === "function") {
					setDraftChannel({
						getDraft: () => (input && typeof input.draft === "string") ? input.draft : "",
						setDraft: (text) => inputActions.setDraft(text)
					});
				}
				// Poll the REAL module state (wsRecording / recording) — the
				// window cache is only a convenience mirror; reading the module
				// variables directly means the button can never go stale.
				const check = () => {
					setRecState({
						recording: wsRecording === true || recording === true,
						busy: false
					});
				};
				check();
				const timer = setInterval(check, 250);
				return () => {
					clearInterval(timer);
					// Release the channel we adopted — after unmount the
					// recorder must not keep writing to a dead composer.
					setDraftChannel(null);
				};
			}, [inputActions, input]);
			const label = recState.recording ? t("mic.recording") : recState.busy ? t("mic.transcribing") : t("mic.tooltip");
			const color = recState.recording ? "#e5484d" : "var(--dsw-alias-label-secondary)";
			return (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				title: label,
				"aria-label": label,
				onClick: (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					toggleRecording();
				},
				style: {
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					width: "32px",
					height: "32px",
					padding: "0",
					background: "transparent",
					border: "1px solid var(--dsw-alias-border-l2)",
					borderRadius: "8px",
					cursor: "pointer",
					color,
					flex: "0 0 auto"
				},
				children: (0, react_jsx_runtime.jsx)("svg", {
					width: "16",
					height: "16",
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "2",
					strokeLinecap: "round",
					strokeLinejoin: "round",
					children: (0, react_jsx_runtime.jsxs)("g", {
						children: [
							(0, react_jsx_runtime.jsx)("path", { d: "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" }),
							(0, react_jsx_runtime.jsx)("path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }),
							(0, react_jsx_runtime.jsx)("line", { x1: "12", y1: "19", x2: "12", y2: "22" })
						]
					})
				})
			});
		}

		/** Register the composer microphone button (conversation.input.right). */
		function registerMicButton(ctx) {
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "dsh-voice-scribe-mic",
				order: 30,
				locale: SETTINGS_NS,
				inject: (sessionId) => ({
					t: ctx.locale.bind(SETTINGS_NS)
				})
			}, MicrophoneButton));
		}

		/**
		 * Register the settings section + row. Called from apply once the
		 * slots / locale services are available.
		 */
		function registerSettings(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: SETTINGS_SECTION_ID,
				order: 30,
				label: "语音输入 / Voice Input",
				locale: SETTINGS_NS,
				children: { "settings.voiceScribe.item": {
					kind: "list",
					scope: "root"
				} }
			}, VoiceScribeSection));

			ctx.slots.inject("settings.voiceScribe.item", () => ctx.slots.register({
				name: "settings.voiceScribe.item",
				id: SETTINGS_SECTION_ID,
				order: 10,
				locale: SETTINGS_NS
			}, VoiceScribeRow));
		}
		//#endregion

		//#region plugin contract
		/** Required services: slots/locale for the settings section, plus the DOM. */
		const inject = ["slots", "locale"];

		/**
		 * Client loader entry: mount the hotkey while the plugin is active,
		 * register the settings section, and tear everything down on dispose.
		 */
		function apply(ctx) {
			ctx.effect(() => {
				boot();
				return () => unmountHotkey();
			}, "dsh-voice-scribe: hotkey");

			// Composer microphone button (best-effort: only DSH shells that
			// expose the conversation.input.right slot get the button; the
			// Alt hotkey still works everywhere).
			try {
				ctx.effect(() => {
					registerMicButton(ctx);
					return () => {};
				}, "dsh-voice-scribe: mic button");
			} catch (error) {
				console.warn("[dsh-voice-scribe] mic button registration skipped:", error && error.message ? error.message : error);
			}

			// Settings section + row (best-effort; never take the plugin down).
			try {
				ctx.effect(() => {
					ctx.locale.register(SETTINGS_NS, settingsLocale);
					registerSettings(ctx);
					return () => {};
				}, "dsh-voice-scribe: settings");
			} catch (error) {
				console.warn("[dsh-voice-scribe] settings registration skipped:", error && error.message ? error.message : error);
			}
		}
		//#endregion

		module.exports = {
			apply,
			inject,
			boot,
			toggleRecording,
			readHotkey,
			readLanguage,
			readPolishEnabled,
			readPolishModel,
			readEngine,
			webSpeechSupported,
			HOTKEYS,
			DEFAULT_ASR_URL,
			DEFAULT_ASR_MODEL
		};
		return module.exports;
	}
});
