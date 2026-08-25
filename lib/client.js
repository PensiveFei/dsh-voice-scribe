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

		//#region dsh-voice-scribe: settings UI
		/** The settings section's locale namespace. */
		const SETTINGS_NS = "settings.voiceScribe";
		/** Settings section id used for slots registration. */
		const SETTINGS_SECTION_ID = "voice-scribe";

		/** Settings row dictionaries — nested per-locale (the shape DSH's locale service expects). */
		const settingsLocale = {
			zh: {
				"engine.title": "识别引擎",
				"engine.web-speech": "浏览器内置识别（Web Speech，推荐，零配置）",
				"engine.cloud-asr": "云端 ASR（OpenAI 兼容，需配置 API key）",
				"language.title": "识别语言",
				"language.auto": "自动（跟随系统）",
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
				"cloud.placeholderModel": "whisper-large-v3"
			},
			en: {
				"engine.title": "Recognition engine",
				"engine.web-speech": "Browser Web Speech (recommended, zero config)",
				"engine.cloud-asr": "Cloud ASR (OpenAI-compatible, requires API key)",
				"language.title": "Recognition language",
				"language.auto": "Auto (follow system)",
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
				"cloud.placeholderModel": "whisper-large-v3"
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

			// Cloud-ASR config state (loaded from host on mount, saved back on demand).
			const [cloudUrl, setCloudUrl] = _react.useState("");
			const [cloudModel, setCloudModel] = _react.useState("");
			const [cloudKey, setCloudKey] = _react.useState("");
			const [cloudHasKey, setCloudHasKey] = _react.useState(false);
			const [cloudStatus, setCloudStatus] = _react.useState("");

			_react.useEffect(() => {
				let cancelled = false;
				void fetchSettings().then((value) => {
					if (cancelled || !value) return;
					if (typeof value.asrUrl === "string") setCloudUrl(value.asrUrl);
					if (typeof value.asrModel === "string") setCloudModel(value.asrModel);
					if (typeof value.hasKey === "boolean") setCloudHasKey(value.hasKey);
				}).catch(() => {});
				return () => { cancelled = true; };
			}, []);

			const saveCloud = () => {
				setCloudStatus("");
				const patch = { asrUrl: cloudUrl.trim(), asrModel: cloudModel.trim() };
				if (cloudKey.trim() !== "") patch.asrApiKey = cloudKey.trim();
				void saveSettings(patch).then((ok) => {
					setCloudStatus(ok ? t("cloud.saved") : t("cloud.failed"));
					setCloudKey("");
					if (ok) setCloudHasKey(true);
					bump();
				}).catch(() => {
					setCloudStatus(t("cloud.failed"));
					bump();
				});
			};

			const children = [
				(0, react_jsx_runtime.jsx)(SelectRow, {
					label: t("engine.title"),
					value: engine,
					options: [
						{ value: "web-speech", label: t("engine.web-speech") },
						{ value: "cloud-asr", label: t("engine.cloud-asr") }
					],
					onChange: (v) => { writeJson(ENGINE_KEY, v); bump(); }
				}),
				(0, react_jsx_runtime.jsx)(SelectRow, {
					label: t("language.title"),
					value: language,
					options: [
						{ value: "", label: t("language.auto") },
						{ value: "zh-CN", label: "普通话 (zh-CN)" },
						{ value: "en-US", label: "English (en-US)" }
					],
					onChange: (v) => { writeJson(LANGUAGE_KEY, v); bump(); }
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

			// Cloud-ASR config block: only visible when the cloud engine is selected.
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
								children: t("cloud.title")
							}),
							(0, react_jsx_runtime.jsx)(TextRow, {
								label: t("cloud.url"),
								value: cloudUrl,
								placeholder: t("cloud.placeholderUrl"),
								onChange: setCloudUrl
							}),
							(0, react_jsx_runtime.jsx)(TextRow, {
								label: t("cloud.model"),
								value: cloudModel,
								placeholder: t("cloud.placeholderModel"),
								onChange: setCloudModel
							}),
							(0, react_jsx_runtime.jsx)(TextRow, {
								label: t("cloud.key"),
								value: cloudKey,
								placeholder: cloudHasKey ? t("cloud.keySet") : "",
								type: "password",
								onChange: setCloudKey
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								style: { display: "flex", alignItems: "center", gap: "10px", marginTop: "6px" },
								children: [
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
