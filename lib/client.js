// dsh-voice-input — browser half (client plugin bundle).
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
	id: "dsh-voice-input",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region constants & settings
		/** localStorage keys (same-origin persistence, mirrors dsh-dream-skin). */
		const SETTINGS_KEY = "dsh-voice-input:settings";
		const ENGINE_KEY = "dsh-voice-input:engine";
		const HOTKEY_KEY = "dsh-voice-input:hotkey";
		const POLISH_KEY = "dsh-voice-input:polish";
		const POLISH_MODEL_KEY = "dsh-voice-input:polish-model";
		const LANGUAGE_KEY = "dsh-voice-input:language";
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
		async function hostCall(body) {
			const res = await fetch(API_PREFIX, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			let data = null;
			try { data = await res.json(); } catch { /* non-JSON */ }
			return data;
		}

		async function transcribe(audioBase64, mimeType, language) {
			const data = await hostCall({ action: "transcribe", audio: audioBase64, mimeType, language: language || "" });
			return data && data.ok === true ? data.text : null;
		}

		async function polish(text, provider, model) {
			const data = await hostCall({ action: "polish", text, provider, model });
			return data && data.ok === true ? data.text : text; // never lose the transcript
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
		/** Recognition engine: "web-speech" (browser built-in, no key) or "cloud-asr" (OpenAI-compatible). */
		function readEngine() {
			const v = readJson(ENGINE_KEY, "web-speech");
			return v === "web-speech" || v === "cloud-asr" ? v : "web-speech";
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
			return v !== null && typeof v === "object" && v !== null ? v : null; // { provider, model }
		}
		//#endregion

		//#region composer DOM helpers
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
				recognition.continuous = true;
				recognition.interimResults = false;
				recognition.lang = readLanguage() || "zh-CN";
				wsFinalText = "";
				pendingWsStop = false;
				recognition.onresult = (event) => {
					for (let i = event.resultIndex; i < event.results.length; i++) {
						if (event.results[i].isFinal) {
							wsFinalText += event.results[i][0].transcript;
						}
					}
				};
				recognition.onerror = (event) => {
					if (event.error === "not-allowed" || event.error === "service-not-allowed") {
						setStatus("❌ 麦克风权限被拒绝（请在浏览器地址栏授予麦克风权限）");
					} else if (event.error === "no-speech") {
						setStatus("未检测到语音");
					} else if (event.error === "network") {
						setStatus("❌ 识别服务网络错误（Web Speech 依赖浏览器语音服务，需联网）");
					} else if (event.error !== "aborted") {
						setStatus("❌ 识别错误：" + event.error);
					}
				};
				recognition.onend = () => {
					// onend fires after every onresult has been delivered — this is
					// the ONLY safe point to read the final transcript. Reading it
					// right after recognition.stop() races the last results.
					const wasRecording = wsRecording;
					wsRecording = false;
					recognition = null;
					if (wasRecording) {
						finishWebSpeech();
					} else if (!pendingWsStop) {
						// Unexpected end (silence timeout etc.) — surface it.
						setStatus("录音已结束（未检测到持续语音）", true);
					}
				};
				recognition.start();
				wsRecording = true;
				setStatus("🎙 录音中…（再按一次结束）", true);
				return true;
			} catch (error) {
				setStatus("❌ 启动识别失败：" + (error && error.message ? error.message : "未知错误"));
				return false;
			}
		}

		/** Set when the user tapped Alt to stop; onend consumes it. */
		let pendingWsStop = false;

		/** Read the final transcript, run optional polish, insert into composer. */
		function finishWebSpeech() {
			setStatus("⏳ 转写中…", true);
			const text = wsFinalText.trim();
			if (!text) {
				setStatus("未识别到文字", true);
				return;
			}
			// Optional polish through DSH's configured model.
			const polishEnabled = readPolishEnabled();
			const polishModel = readPolishModel();
			const insert = (finalText) => {
				const ta = findComposerTextarea();
				if (ta && insertIntoComposer(ta, finalText)) setStatus("✅ 已插入");
				else setStatus("❌ 未找到输入框", true);
			};
			if (polishEnabled && polishModel && polishModel.provider && polishModel.model) {
				setStatus("✨ 润色中…");
				void polish(text, polishModel.provider, polishModel.model).then(insert);
			} else {
				insert(text);
			}
		}

		function stopWebSpeech() {
			if (!wsRecording || !recognition) return;
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
			const preferred = ["audio/webm", "audio/mp4", "audio/ogg"];
			const mime = preferred.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) || "";
			recordingMimeType = mime || "audio/webm";
			recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
			recorder.ondataavailable = (event) => {
				if (event.data && event.data.size > 0) recordingChunks.push(event.data);
			};
			recorder.onstop = () => {
				const blob = new Blob(recordingChunks, { type: recordingMimeType });
				void finishRecording(blob);
			};
			recorder.start();
			recording = true;
			recordingStartTime = Date.now();
			setStatus("🎙 录音中…（再按一次结束）", true);
			return true;
		}

		async function finishRecording(blob) {
			recording = false;
			if (stream) {
				stream.getTracks().forEach((track) => track.stop());
				stream = null;
			}
			if (blob.size < 200) {
				setStatus("录音太短，未转写");
				return;
			}
			setStatus("⏳ 转写中…", true);
			try {
				const reader = new FileReader();
				const base64 = await new Promise((resolve, reject) => {
					reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
					reader.onerror = reject;
					reader.readAsDataURL(blob);
				});
				const language = readLanguage();
				let text = await transcribe(base64, blob.type || recordingMimeType, language);
				if (!text) {
					setStatus("❌ 转写失败：请检查设置中的 ASR 配置");
					return;
				}
				// Optional polish through DSH's configured model.
				const polishEnabled = readPolishEnabled();
				const polishModel = readPolishModel();
				if (polishEnabled && polishModel && polishModel.provider && polishModel.model) {
					setStatus("✨ 润色中…");
					text = await polish(text, polishModel.provider, polishModel.model);
				}
				const ta = findComposerTextarea();
				if (ta && insertIntoComposer(ta, text)) {
					setStatus("✅ 已插入");
				} else {
					setStatus("❌ 未找到输入框");
				}
			} catch (error) {
				setStatus("❌ 转写失败：" + (error && error.message ? error.message : "未知错误"));
			}
		}

		function stopRecording() {
			if (!recording || !recorder) return;
			try {
				recorder.stop();
			} catch {
				recording = false;
				if (stream) {
					stream.getTracks().forEach((track) => track.stop());
					stream = null;
				}
				setStatus("已停止", true);
			}
		}

		function toggleRecording() {
			const engine = readEngine();
			if (engine === "web-speech") {
				if (wsRecording) stopWebSpeech();
				else void startWebSpeech();
				return;
			}
			if (recording) stopRecording();
			else void startRecording();
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

		let lastToggleAt = 0;
		function onKeyDown(event) {
			const hotkey = readHotkey();
			if (!matchesHotkey(event, hotkey)) return;
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
		}
		//#endregion

		//#region plugin contract
		/** No cordis services are required; the plugin only touches the DOM. */
		const inject = [];

		/**
		 * Client loader entry: mount the hotkey while the plugin is active and
		 * tear it down on dispose.
		 */
		function apply(ctx) {
			ctx.effect(() => {
				boot();
				return () => unmountHotkey();
			}, "dsh-voice-input: hotkey");
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
