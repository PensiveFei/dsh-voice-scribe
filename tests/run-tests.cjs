// tests/run-tests.cjs — offline unit tests.
//
// Two layers:
//   1) REAL behavioural tests for lib/host-utils.js (dependency-free ESM, so
//      we import it directly): 413 overflow path, language normalization,
//      ASR error mapping, settings round-trip, trust fence.
//   2) Source-shape checks for the plugin wiring that needs the DSH host or
//      browser (route actions, client registration, locale shape, hotkeys).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅', name); }
  catch (e) { failed++; console.error('  ❌', name, '—', e.message); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log('  ✅', name); }
  catch (e) { failed++; console.error('  ❌', name, '—', e.message); }
}

// Normalise line endings before any source-shape assertion: several of them
// count characters between two markers (e.g. [\s\S]{0,420}), so a CRLF
// checkout — the default on Windows with core.autocrlf=true — would make
// them fail locally while the Linux CI runner stayed green.
const readSource = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const src = readSource(path.join('lib', 'index.js'));
const clientSrc = readSource(path.join('lib', 'client.js'));
const utilsSrc = readSource(path.join('lib', 'host-utils.js'));

// ---------- server-side: source shape (needs DSH host to mount) ----------
test('host: exports name and inject', () => {
  assert.ok(/export const name = "dsh-voice-scribe"/.test(src));
  assert.ok(/export const inject = \["webServer", "webRuntime", "llm"\]/.test(src));
});

test('host: local-transcribe threads the request abort signal into the decoder', () => {
  // Without it a client that timed out or navigated away left a core-busy
  // sherpa decode (and every queued decode behind it) running for minutes.
  assert.ok(src.includes('transcribePcm(base64ToFloat32(audio), sampleRate, modelDir(), abort.signal)'));
});

test('host: has transcribe/polish/list-models/local actions', () => {
  assert.ok(src.includes('action === "transcribe"'));
  assert.ok(src.includes('action === "polish"'));
  assert.ok(src.includes('action === "list-models"'));
  assert.ok(src.includes('action === "get-settings"'));
  assert.ok(src.includes('action === "set-settings"'));
  assert.ok(src.includes('action === "local-status"'));
  assert.ok(src.includes('action === "local-download"'));
  assert.ok(src.includes('action === "local-transcribe"'));
  assert.ok(src.includes('from "./local-asr.js"'));
});

test('host: get-settings never exposes the key', () => {
  // The get-settings response must expose hasKey, not the key itself.
  const getSettingsBlock = src.match(/action === "get-settings"[\s\S]*?return;/) || [''];
  assert.ok(getSettingsBlock[0].includes('hasKey'), 'should expose hasKey');
  assert.ok(!getSettingsBlock[0].includes('asrApiKey: settings.asrApiKey'), 'must not serialize the key');
  assert.ok(!/value:\s*\{[\s\S]{0,160}asrApiKey/.test(getSettingsBlock[0]), 'response value must not contain the key');
});

test('host: default ASR is Groq whisper-large-v3 (in host-utils)', () => {
  assert.ok(utilsSrc.includes('https://api.groq.com/openai/v1/audio/transcriptions'));
  assert.ok(utilsSrc.includes('whisper-large-v3'));
});

test('host: polish failure keeps raw transcript', () => {
  assert.ok(src.includes('return raw; // any polish failure → keep the raw transcript'));
});

test('host: polishText pre-cleans with localPolish before the LLM', () => {
  assert.ok(src.includes('const cleaned = localPolish(raw);'), 'local pre-polish must run before the LLM call');
  assert.ok(src.includes('text: cleaned'), 'the LLM must receive the locally-cleaned text');
});

test('host: 413 overflow path is reachable (no hang, real response)', () => {
  // Regression for the old destroy-and-never-resolve hang: readJsonBody must
  // resolve a sentinel and handleApi must answer 413 with Connection: close.
  assert.ok(src.includes('payload === PAYLOAD_TOO_LARGE'));
  assert.ok(src.includes('writeJson(res, 413'));
  assert.ok(src.includes('res.setHeader("connection", "close")'));
  assert.ok(utilsSrc.includes('resolve(PAYLOAD_TOO_LARGE)'));
  assert.ok(!utilsSrc.includes('req.destroy()'), 'must not destroy the stream before the 413 is sent');
});

test('host: trustedHosts validated once at apply()', () => {
  assert.ok(src.includes('buildTrustedHosts(ctx.webRuntime.trustedHosts'));
  assert.ok(!/isTrustedApiRequest[\s\S]{0,200}assertTrustedAuthority/.test(src), 'no per-request assert in the handler path');
});

test('host: set-settings validates asrUrl and trims values', () => {
  assert.ok(src.includes('asrUrl must be an http(s) URL'));
  assert.ok(src.includes('trimmed === ""') && src.includes('delete next[key]'));
});

test('host: client abort cancels in-flight ASR/polish', () => {
  assert.ok(src.includes('signal: abort.signal'));
  assert.ok(src.includes('req.on("aborted"'));
  assert.ok(src.includes('res.on("close"'));
});

test('host: pure helpers imported from host-utils', () => {
  assert.ok(src.includes('"./host-utils.js"'));
});

test('host: dsh-llm is lazy-loaded (index.js importable offline)', () => {
  assert.ok(!/^import \{ createUserMessage \} from "@deepseek-ai\/dsh-llm"/m.test(src), 'no static dsh-llm import at module load');
  assert.ok(src.includes('await import("@deepseek-ai/dsh-llm")'), 'lazy import inside polishText');
  assert.ok(src.includes('export async function polishText'));
  assert.ok(src.includes('export async function handleApi'));
});

test('host: trust fence blocks cross-site (in host-utils)', () => {
  assert.ok(utilsSrc.includes('sec-fetch-site'));
  assert.ok(utilsSrc.includes('isLoopbackHostname'));
});

test('host: hot-word table applies to cloud and local transcription', () => {
  assert.ok(src.includes('applyHotwords(text, loadHotwords().rules)'));
  // Both transcription paths (cloud + local) wrap their result with hot words.
  const transcribeBlock = src.match(/action === "transcribe"[\s\S]*?return;/) || [''];
  assert.ok(transcribeBlock[0].includes('applyHotwords'), 'cloud transcribe must apply hot words');
  const localBlock = src.match(/action === "local-transcribe"[\s\S]{0,900}applyHotwords/) || [''];
  assert.ok(localBlock.length > 0, 'local transcribe must apply hot words');
});

test('host: get-settings exposes polishPrompt and hot-word status (no content)', () => {
  const block = src.match(/action === "get-settings"[\s\S]*?return;/) || [''];
  assert.ok(block[0].includes('polishPrompt'), 'custom polish prompt view present');
  assert.ok(block[0].includes('hotwords'), 'hot-word status present');
  assert.ok(block[0].includes('hotwordsPath()'), 'hot-word path exposed so users can find the file');
  assert.ok(block[0].includes('rules: hotwords.rules.length'), 'must expose the COUNT, not the rules themselves');
});

test('host: set-settings accepts polishPrompt with a length cap', () => {
  assert.ok(src.includes('key !== "polishPrompt"'));
  assert.ok(src.includes('MAX_POLISH_PROMPT_CHARS'));
  assert.ok(src.includes('polishPrompt is too long'));
});

test('host: polish route resolves the custom prompt from settings', () => {
  assert.ok(src.includes('prompt: resolvePolishPrompt(readSettings())'));
  assert.ok(utilsSrc.includes('export function resolvePolishPrompt'));
  assert.ok(utilsSrc.includes('export const DEFAULT_POLISH_PROMPT'));
});

test('host: polishText forwards an already-aborted signal (no 30s zombie call)', () => {
  // A client that hung up BEFORE polishText ran must not burn the full
  // POLISH_TIMEOUT_MS — an already-aborted signal never fires "abort" again
  // for late listeners, so the state must be forwarded explicitly (the same
  // trap the ASR path in host-utils guards against).
  assert.ok(src.includes('if (signal && signal.aborted) timeout.abort(signal.reason)'));
});

test('host: polishText only concatenates string text-delta chunks', () => {
  // Unknown chunks (tool-use, …) used to append "undefined" to the result.
  assert.ok(src.includes('chunk.type === "text-delta" && typeof chunk.text === "string"'));
});

// ---------- client-side: source shape (needs browser DOM) ----------
test('client: loads via ModuleLoader with the registered id', () => {
  assert.ok(clientSrc.includes('window.__ModuleLoader__.load'));
  assert.ok(clientSrc.includes('id: "dsh-voice-scribe"'));
});

test('client: supports alt and alt-space hotkeys', () => {
  assert.ok(clientSrc.includes('HOTKEYS = ["alt", "alt-space"]'));
  // The keyboard grammar is normalized through canonical tokens so arbitrary
  // chords work too: " " → "space", "Control" → "ctrl".
  assert.ok(clientSrc.includes('if (rawKey === " ") return "space"'));
  assert.ok(clientSrc.includes('if (lower === "control") return "ctrl"'));
  // Presets resolve through parseHotkey: the stored "alt-space" preset name
  // maps to the "alt+space" chord.
  assert.ok(clientSrc.includes('parseHotkeyCombo(hotkey === "alt-space" ? "alt+space" : hotkey)'));
  // Matching is exact on modifiers — no stray Ctrl/Meta/Shift toggles.
  assert.ok(clientSrc.includes('if (parsed.mods.alt !== event.altKey) return false;'));
});

test('client: supports a custom hotkey option (custom:<combo>)', () => {
  assert.ok(clientSrc.includes('CUSTOM_HOTKEY_PREFIX = "custom:"'));
  assert.ok(clientSrc.includes('parseHotkeyCombo'));
  assert.ok(clientSrc.includes('canonicalComboText'));
  assert.ok(clientSrc.includes('serializeEventKey'));
  assert.ok(clientSrc.includes('hotkeyDisplay'));
  // The settings select offers the "custom" option and re-reads the stored
  // chord when the user picks it.
  assert.ok(clientSrc.includes('value: "custom", label: t("hotkey.custom")'));
  assert.ok(clientSrc.includes('readCustomHotkeyCombo'));
  assert.ok(clientSrc.includes('"hotkey.custom"'));
  assert.ok(clientSrc.includes('"hotkey.customHint"'));
  // Status strings surface the real hotkey instead of a hardcoded Alt.
  assert.ok(clientSrc.includes('请再按一次 " + activeTriggerName()'));
});

test('client: custom hotkey recorder captures keydown/keyup and saves a validated combo', () => {
  assert.ok(clientSrc.includes('onCaptureKeyDown'));
  assert.ok(clientSrc.includes('onCaptureKeyUp'));
  assert.ok(clientSrc.includes('serializeEventKey(event)'));
  assert.ok(clientSrc.includes('isModifierToken(token)'));
  assert.ok(clientSrc.includes('canonicalComboText(customHotkey)'));
  assert.ok(clientSrc.includes('writeJson(HOTKEY_KEY, CUSTOM_HOTKEY_PREFIX + combo)'));
  // A modifier released alone becomes a modifier-only hotkey (e.g. "alt").
  assert.ok(clientSrc.includes('if (normalizeKeyToken(event.key) === pendingMod)'));
});

test('client: defaults to web-speech engine (zero key / zero config)', () => {
  assert.ok(clientSrc.includes('ENGINE_KEY = "dsh-voice-input:engine"'));
  assert.ok(clientSrc.includes('readEngine'));
  assert.ok(clientSrc.includes('"web-speech"'));
  assert.ok(clientSrc.includes('SpeechRecognition || window.webkitSpeechRecognition'));
  assert.ok(clientSrc.includes('toggleRecording'));
});

test('client: web speech reads transcript in onend (not right after stop)', () => {
  assert.ok(clientSrc.includes('recognition.onend'));
  assert.ok(clientSrc.includes('finishWebSpeech()'));
  assert.ok(clientSrc.includes('pendingWsStop'));
  assert.ok(clientSrc.includes('event.error === "network"'));
});

test('client: cloud-asr remains as optional engine', () => {
  assert.ok(clientSrc.includes('"cloud-asr"'));
  assert.ok(clientSrc.includes('MediaRecorder'));
});

test('client: inserts via setRangeText + input event', () => {
  assert.ok(clientSrc.includes('setRangeText'));
  assert.ok(clientSrc.includes('new Event("input", { bubbles: true })'));
});

test('client: finds composer textarea via data-composer-card', () => {
  assert.ok(clientSrc.includes('[data-composer-card="true"]'));
});

test('client: API key never stored in localStorage or logged', () => {
  assert.ok(!/localStorage[\s\S]{0,80}asrApiKey/.test(clientSrc), 'asrApiKey must not be written to localStorage');
  assert.ok(!/setStatus\([^)]*key/i.test(clientSrc), 'key must not appear in status messages');
  assert.ok(clientSrc.includes('row.key = p.key.trim()') || clientSrc.includes('patch.asrApiKey = cloudKey.trim()'), 'key flows to the host patch, never to localStorage');
  assert.ok(!/localStorage[\s\S]{0,120}\.key/.test(clientSrc), 'provider keys must not touch localStorage');
});

test('client: registers a settings section (engine/language/hotkey/polish)', () => {
  assert.ok(clientSrc.includes('ctx.slots.inject("settings.section"'));
  assert.ok(clientSrc.includes('settings.voiceScribe.item'));
  assert.ok(clientSrc.includes('VoiceScribeRow'));
  assert.ok(clientSrc.includes('ctx.locale.register'));
  assert.ok(clientSrc.includes('inject = ["slots", "locale"]'));
  assert.ok(clientSrc.includes('writeJson(ENGINE_KEY'));
  assert.ok(clientSrc.includes('writeJson(LANGUAGE_KEY'));
  assert.ok(clientSrc.includes('writeJson(HOTKEY_KEY'));
  assert.ok(clientSrc.includes('writeJson(POLISH_KEY'));
});

test('client: locale dictionary is nested per-language (zh/en)', () => {
  assert.ok(clientSrc.includes('zh: {'));
  assert.ok(clientSrc.includes('en: {'));
  assert.ok(clientSrc.includes('"engine.title": "识别引擎"'));
  assert.ok(clientSrc.includes('"engine.title": "Recognition engine"'));
});

test('client: settings row re-renders on change (useState bump)', () => {
  assert.ok(clientSrc.includes('_react.useState(0)'));
  assert.ok(clientSrc.includes('forceRender'));
  assert.ok(clientSrc.includes('bump()'));
});

test('client: picking "custom" keeps the dropdown on custom before saving', () => {
  // Regression: the dropdown value used to be derived from readHotkey(), so
  // choosing "custom" snapped back to the active preset (nothing is written to
  // storage until Save) and the recorder row never appeared.
  assert.ok(clientSrc.includes('const [hotkeyChoice, setHotkeyChoice] = _react.useState(hotkeyIsCustom ? "custom" : hotkey)'));
  assert.ok(clientSrc.includes('value: hotkeyChoice'));
  assert.ok(clientSrc.includes('setHotkeyChoice("custom")'));
  assert.ok(clientSrc.includes('if (hotkeyChoice !== "custom") return null'));
  assert.ok(clientSrc.includes('setHotkeyChoice(v)'));
});

test('client: web-speech error is not swallowed by onend', () => {
  assert.ok(clientSrc.includes('wsError = event.error || "unknown"'));
  assert.ok(clientSrc.includes('if (wsError !== null) {'));
  assert.ok(/onerror = \(event\) => \{[\s\S]*?wsError/.test(clientSrc));
});

test('client: web-speech network error guides the user to cloud ASR', () => {
  // A bare "需联网" leaves users stuck on mainland-China networks where the
  // Google/Microsoft speech backend is blocked — the message must say how to
  // switch engines.
  assert.ok(clientSrc.includes('切换「本地离线识别」或「云端 ASR」'));
  assert.ok(/event\.error === "network"[\s\S]{0,600}切换「本地离线识别」/.test(clientSrc));
  assert.ok(clientSrc.includes('warn.wsChrome'), 'Chrome users need a settings hint (Google is blocked in CN; Edge uses Microsoft)');
});

test('client: hostCall has a timeout (no infinite "转写中")', () => {
  assert.ok(clientSrc.includes('HOST_CALL_TIMEOUT_MS'));
  assert.ok(clientSrc.includes('new AbortController()'));
  assert.ok(clientSrc.includes('signal: controller.signal'));
  assert.ok(clientSrc.includes('"host-timeout"'));
});

test('client: transcribe surfaces the host error message', () => {
  assert.ok(clientSrc.includes('return { ok: false, error: msg }'));
  assert.ok(clientSrc.includes('result.error'));
});

test('client: interim results enabled + interim fallback on stop', () => {
  assert.ok(clientSrc.includes('recognition.interimResults = true'));
  assert.ok(clientSrc.includes('wsLastInterim'));
  assert.ok(clientSrc.includes('text = (wsLastInterim || "").trim()'));
});

test('client: stop shows immediate processing feedback', () => {
  assert.ok(clientSrc.includes('setStatus("⏳ 处理中…", true)'));
});

test('client: MediaRecorder failure releases the microphone stream', () => {
  assert.ok(clientSrc.includes('stream.getTracks().forEach((track) => track.stop());'));
  assert.ok(clientSrc.includes('new MediaRecorder(stream'));
});

test('client: cloud-ASR config block appears when engine = cloud-asr', () => {
  assert.ok(clientSrc.includes('addProvider'));
  assert.ok(clientSrc.includes('engine === "cloud-asr"'));
  assert.ok(clientSrc.includes('saveCloud'));
  assert.ok(clientSrc.includes('type: "password"'));
  assert.ok(clientSrc.includes('saveSettings(patch)'));
});

test('client: polish never rejects and keeps raw transcript on failure', () => {
  // Regression for the "✨ 润色中… stuck forever + unhandled rejection" bug:
  // polish() must swallow host/network errors and only accept a real string.
  assert.ok(/async function polish[\s\S]{0,400}catch \{/.test(clientSrc));
  assert.ok(clientSrc.includes('return data && data.ok === true && typeof data.text === "string" ? data.text : text;'));
});

test('client: finishWebSpeech has a defensive catch on polish', () => {
  assert.ok(clientSrc.includes('.then(insert).catch(() => insert(text))'));
});

test('client: hotkey ignores repeats and non-composer editable focus', () => {
  assert.ok(clientSrc.includes('if (event.repeat) return;'));
  assert.ok(clientSrc.includes('isEditableElement(active)'));
  assert.ok(clientSrc.includes('isComposerEditable(active)'));
});

test('client: status pill is accessible (aria-live)', () => {
  assert.ok(clientSrc.includes('setAttribute("role", "status")'));
  assert.ok(clientSrc.includes('setAttribute("aria-live", "polite")'));
});

test('client: cloud config has clear-key + URL validation + engine warnings', () => {
  assert.ok(clientSrc.includes('clearCloudKey'));
  assert.ok(clientSrc.includes('cloud.urlInvalid'));
  assert.ok(clientSrc.includes('cloud.clearKey'));
  assert.ok(clientSrc.includes('warn.wsUnsupported'));
  assert.ok(clientSrc.includes('warn.noKey'));
});

test('client: host language default syncs into localStorage when unset', () => {
  assert.ok(clientSrc.includes('readLanguage() === ""'));
  assert.ok(clientSrc.includes('writeJson(LANGUAGE_KEY, value.language)'));
});

test('client: pre-0.2.0 persisted "web-speech" migrates to the auto default', () => {
  assert.ok(clientSrc.includes('ENGINE_MIGRATED_KEY'));
  assert.ok(clientSrc.includes('writeJson(ENGINE_KEY, "auto")'));
  assert.ok(clientSrc.includes('engine-migrated-v2'));
});

test('client: no-key warning is gated on the cloud engine (auto/local are keyless)', () => {
  // Regression: the warning used to show on auto/local too, telling users of
  // the keyless engines to configure an API key they will never need.
  assert.ok(clientSrc.includes('engine === "cloud-asr" ? (cloudHasKey ? "" : t("warn.noKey")) : ""'));
});

test('client: polish status is persistent (no premature fade)', () => {
  assert.ok(clientSrc.includes('setStatus("✨ 润色中…", true)'));
  assert.ok(!clientSrc.includes('setStatus("✨ 润色中…")'), 'transient polish status would fade mid-call');
});

test('client: local-transcribe gets a longer timeout than the generic cap', () => {
  assert.ok(clientSrc.includes('LOCAL_TRANSCRIBE_TIMEOUT_MS = 180_000'));
  assert.ok(clientSrc.includes('async function hostCall(body, timeoutMs)'));
  assert.ok(clientSrc.includes('sampleRate: 16000 }, LOCAL_TRANSCRIBE_TIMEOUT_MS)'));
});

test('client: language picker offers Cantonese/Japanese/Korean', () => {
  assert.ok(clientSrc.includes('"yue-Hant-HK"'));
  assert.ok(clientSrc.includes('"ja-JP"'));
  assert.ok(clientSrc.includes('"ko-KR"'));
  assert.ok(clientSrc.includes('language.note'));
});

test('client: ensureLocalModel is re-entrant (shared in-flight promise)', () => {
  assert.ok(clientSrc.includes('localModelPromise'));
  assert.ok(clientSrc.includes('if (localModelPromise) return localModelPromise;'));
});

test('client: auto engine routes local-first and falls back from Web Speech', () => {
  assert.ok(clientSrc.includes('readJson(ENGINE_KEY, "auto")'));
  assert.ok(clientSrc.includes('function effectiveEngine()'));
  assert.ok(clientSrc.includes('localReady ? "local" : "web-speech"'));
  assert.ok(clientSrc.includes('void autoFallbackToLocal()'));
  assert.ok(clientSrc.includes('event.error === "network"'));
});

test('client: local engine decodes PCM in-browser and posts to host', () => {
  assert.ok(clientSrc.includes('function blobToPcm16k'));
  assert.ok(clientSrc.includes('decodeAudioData'));
  assert.ok(clientSrc.includes('function f32ToBase64'));
  assert.ok(clientSrc.includes('action: "local-transcribe"'));
  assert.ok(clientSrc.includes('action: "local-status"'));
  assert.ok(clientSrc.includes('action: "local-download"'));
});

test('client: local decode cannot hang (ArrayBuffer + timeout)', () => {
  // Passing a Blob straight into decodeAudioData is non-standard and can
  // silently never call back in Edge — the fix converts to ArrayBuffer first
  // and adds a hard 30s timeout so the pill can never stick.
  assert.ok(clientSrc.includes('await blob.arrayBuffer()'));
  assert.ok(clientSrc.includes('setTimeout(() => {'));
  assert.ok(clientSrc.includes('音频解码超时'));
});

test('client: registers a composer microphone button (conversation.input.right)', () => {
  assert.ok(clientSrc.includes('ctx.slots.inject("conversation.input.right"'));
  assert.ok(clientSrc.includes('MicrophoneButton'));
  assert.ok(clientSrc.includes('registerMicButton'));
  assert.ok(clientSrc.includes('dsh-voice-scribe-mic'));
});

test('client: draft channel prefers the slot, falls back to the composer editor', () => {
  assert.ok(clientSrc.includes('function setDraftChannel'));
  assert.ok(clientSrc.includes('function draftText()'));
  assert.ok(clientSrc.includes('function setDraftText(text)'));
  assert.ok(clientSrc.includes('function commitTranscript(baseline, finalText)'));
  assert.ok(clientSrc.includes('function rollbackPreview(baseline)'));
  assert.ok(clientSrc.includes('draftChannel && typeof draftChannel.setDraft === "function"'));
  assert.ok(clientSrc.includes('const editor = findComposerEditor();'));
});

test('client: reads the composer draft through the DSH 0.1.2 useInput hook', () => {
  // DSH 0.1.2 hands session-scope slot entries useInput (a snapshot selector
  // hook) and NOT a resolved input prop: reading input.draft answered "" for
  // ever, so the baseline stayed empty and every transcript REPLACED the
  // user's draft instead of appending to it.
  assert.ok(clientSrc.includes('function MicrophoneButton({ input, useInput, inputActions, t: injectedT })'));
  assert.ok(clientSrc.includes('useDraft((state) =>'), 'the live draft must come from the slot hook');
  assert.ok(clientSrc.includes('getDraft: () => draftRef.current'));
  assert.ok(!clientSrc.includes('getDraft: () => (input && typeof input.draft === "string")'),
    'the always-empty input.draft read must be gone');
});

test('client: the composer editor resolves to a contenteditable (DSH 0.1.2+)', () => {
  // 0.1.2 replaced the composer textarea with a Lexical contenteditable inside
  // [data-composer-card]: the textarea-only lookup returned null, so the DOM
  // fallback silently dropped every transcript AND classified the focused
  // composer as a non-composer editable, which killed the Alt hotkey.
  assert.ok(clientSrc.includes('function findComposerEditor()'));
  assert.ok(/card\.querySelector\('\[contenteditable="true"\]'\)/.test(clientSrc), 'the card lookup must fall through to the contenteditable');
  assert.ok(clientSrc.includes('function readEditorText(editor)'));
  assert.ok(clientSrc.includes('function writeEditorText(editor, text)'));
  assert.ok(clientSrc.includes('document.execCommand("insertText"'), 'Lexical only syncs through its own input pipeline');
  assert.ok(/el\.closest\('\[data-composer-card="true"\]'\)/.test(clientSrc), 'composer focus must classify as the composer');
});

test('client: web speech streams interim results into the composer in realtime', () => {
  assert.ok(clientSrc.includes('wsDraftBase'));
  assert.ok(clientSrc.includes('writePreviewSpan(wsDraftBase + sep + wsLastInterim)'));
  assert.ok(clientSrc.includes('interimChanged'));
});

test('client: local engine realtime preview (3s cadence) while recording', () => {
  assert.ok(clientSrc.includes('runLocalPreview'));
  assert.ok(clientSrc.includes('localPreviewTimer = setInterval'));
  assert.ok(clientSrc.includes('recDraftBase'));
  assert.ok(clientSrc.includes('clearInterval(localPreviewTimer)'));
});

test('client: cloud settings UI edits a provider chain (not a single endpoint)', () => {
  assert.ok(clientSrc.includes('const [providers, setProviders]'));
  assert.ok(clientSrc.includes('updateProvider'));
  assert.ok(clientSrc.includes('addProvider'));
  assert.ok(clientSrc.includes('removeProvider'));
  assert.ok(clientSrc.includes('asrProviders: chain'));
  assert.ok(clientSrc.includes('cloud.addProvider'));
  assert.ok(clientSrc.includes('cloud.removeProvider'));
});

test('client: push-to-talk mode (hold) coexists with tap mode', () => {
  assert.ok(clientSrc.includes('MODE_KEY = "dsh-voice-input:mode"'));
  assert.ok(clientSrc.includes('MODES = ["tap", "hold"]'));
  assert.ok(clientSrc.includes('function readMode()'));
  assert.ok(clientSrc.includes('function beginHold()'));
  assert.ok(clientSrc.includes('function endHold()'));
  assert.ok(clientSrc.includes('readMode() === "hold"'));
});

test('client: hold mode stops on keyup and window blur', () => {
  assert.ok(clientSrc.includes('function onKeyUp(event)'));
  assert.ok(clientSrc.includes('matchesHoldRelease'));
  assert.ok(clientSrc.includes('window.addEventListener("keyup", onKeyUp, true)'));
  assert.ok(clientSrc.includes('window.addEventListener("blur", onWindowBlur)'));
  assert.ok(clientSrc.includes('window.removeEventListener("keyup", onKeyUp, true)'));
  assert.ok(clientSrc.includes('window.removeEventListener("blur", onWindowBlur)'));
  assert.ok(clientSrc.includes('function onWindowBlur()'));
});

test('client: releasing before an async start lands still stops the recording', () => {
  // getUserMedia resolves after the user may have released the key — the
  // start path must consume holdStopPending and stop immediately.
  assert.ok(clientSrc.includes('holdStopPending'));
  // The bound is a locality guard, not a length assertion: the device fall-back
  // and the level-peak reset legitimately sit in this span.
  assert.ok(/recording = true;[\s\S]{0,900}if \(holdStopPending\)/.test(clientSrc), 'startRecording must consume holdStopPending');
  assert.ok(/wsRecording = true;[\s\S]{0,800}if \(holdStopPending\)/.test(clientSrc), 'startWebSpeech must consume holdStopPending');
});

test('client: mic button mirrors the hold gesture in hold mode', () => {
  assert.ok(clientSrc.includes('pressProps'));
  assert.ok(clientSrc.includes('onPointerDown'));
  assert.ok(clientSrc.includes('onPointerUp'));
  assert.ok(clientSrc.includes('onPointerLeave'));
  assert.ok(clientSrc.includes('mic.tooltipHold'));
});

test('client: hold-mode recording status says 松开结束', () => {
  assert.ok(clientSrc.includes('readMode() === "hold" ? "松开结束" : "再按一次结束"'));
});

test('client: recording level meter (Web Audio analyser) with full teardown', () => {
  assert.ok(clientSrc.includes('function startLevelMeter'));
  assert.ok(clientSrc.includes('function stopLevelMeter'));
  assert.ok(clientSrc.includes('createAnalyser'));
  assert.ok(clientSrc.includes('getByteFrequencyData'));
  assert.ok(clientSrc.includes('frequencyBinCount'));
  // Teardown must run on every recording-exit path.
  const finishBlock = clientSrc.match(/async function finishRecording[\s\S]*?if \(blob\.size < 200\)/) || [''];
  assert.ok(finishBlock[0].includes('stopLevelMeter()'), 'finishRecording must stop the meter');
  const stopBlock = clientSrc.match(/function stopRecording\(\)[\s\S]*?recorder\.stop\(\);[\s\S]*?\} catch \{[\s\S]*?\n\t+\}/) || [''];
  assert.ok(stopBlock[0].includes('stopLevelMeter()'), 'stopRecording catch path must stop the meter');
  assert.ok(/catch \{[\s\S]{0,80}stopLevelMeter\(\);/.test(clientSrc), 'startLevelMeter failure must clean up, never break recording');
});

test('client: settings UI for trigger mode, hot words and polish prompt', () => {
  assert.ok(clientSrc.includes('writeJson(MODE_KEY, v)'));
  assert.ok(clientSrc.includes('t("mode.title")'));
  assert.ok(clientSrc.includes('t("hw.title")'));
  assert.ok(clientSrc.includes('t("hw.loaded")'));
  assert.ok(clientSrc.includes('hotwordsInfo.path'));
  assert.ok(clientSrc.includes('setHotwordsInfo(value.hotwords)'));
  assert.ok(clientSrc.includes('polishPromptText'));
  assert.ok(clientSrc.includes('savePolishPrompt'));
  assert.ok(clientSrc.includes('polishPrompt: value'));
  assert.ok(clientSrc.includes('"textarea"'));
  assert.ok(clientSrc.includes('t("prompt.placeholder")'));
});

// ---------- repo-level consistency ----------
test('repo: cordis.patch.yml name matches plugin name', () => {
  const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.includes("name: 'dsh-voice-scribe'"));
  assert.ok(patch.includes('id: voice-scribe'));
  assert.ok(!patch.includes('dsh-voice-input'), 'patch must not reference the old package name');
});

test('repo: package.json files entries all exist', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  // Never pin the exact version (it changes every release); check the shape
  // and that package-lock agrees with package.json instead.
  assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version), 'version must be semver x.y.z');
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.strictEqual(lock.packages[''].version, pkg.version, 'package-lock must match package.json version');
  for (const f of pkg.files) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), 'files entry missing: ' + f);
  }
});

test('repo: the manifest cannot drag the DSH core tree into a plugin install', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  // npm 7+ auto-installs peerDependencies. With a bare peer on
  // @deepseek-ai/dsh-llm, "npm install dsh-voice-scribe" pulled in 15 packages
  // including a whole parallel @deepseek-ai core tree — which is exactly how a
  // host running one core version ends up with two and stops booting.
  // Declaring the peer optional takes that same install from 15 packages to 1.
  assert.ok(pkg.peerDependenciesMeta, 'peerDependenciesMeta must exist');
  for (const name of Object.keys(pkg.peerDependencies || {})) {
    const meta = pkg.peerDependenciesMeta[name];
    assert.ok(meta && meta.optional === true, name + ' must be declared an OPTIONAL peer');
  }
  // The native ASR binding has no prebuild for every platform, and only the
  // local engine needs it — a missing one must not fail the whole install.
  assert.ok(!(pkg.dependencies && pkg.dependencies['sherpa-onnx-node']),
    'sherpa-onnx-node must not be a hard dependency');
  assert.ok(pkg.optionalDependencies && pkg.optionalDependencies['sherpa-onnx-node'],
    'sherpa-onnx-node must be an optionalDependency');
  // semver's prerelease rule: a range that contains a prerelease admits
  // prereleases ONLY for that exact major.minor.patch tuple. So ">=0.1.0-rc.6"
  // covers 0.1.0-rc.x but NOT 0.1.2-alpha.x, and ">=0.1.2-alpha.2" covers the
  // alpha line but NOT any 0.1.0-rc.x host. Several DSH lines are in the wild
  // at once, so the range must name every published prerelease tuple.
  //
  // The check is DERIVED from the real registry list instead of a hand-copied
  // line list: the hand-written version named five lines and still missed
  // 0.1.6-alpha.1 — the current `alpha` dist-tag — so that whole generation of
  // hosts silently got an unmet peer. Add new lines to `published` when DSH
  // publishes them, and this test will demand them in the range.
  const llm = pkg.peerDependencies['@deepseek-ai/dsh-llm'];
  const PUBLISHED_DSH_LLM = [
    '0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8',
    '0.1.1-rc.1', '0.1.1-rc.2',
    '0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-alpha.4', '0.1.2-alpha.5', '0.1.2-rc.1',
    '0.1.3-alpha.2',
    '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2',
    '0.1.6-alpha.1'
  ];
  // Minimal semver precedence for the shapes DSH publishes (x.y.z[-pre]).
  const parseVer = (v) => {
    const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!m) return null;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
  };
  const cmpPre = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i], y = b[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
      if (xn && yn) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1; }
      else if (xn !== yn) return xn ? -1 : 1;
      else if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };
  const cmpVer = (a, b) => {
    for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] < b.nums[i] ? -1 : 1;
    if (a.pre.length === 0 || b.pre.length === 0) {
      return a.pre.length === b.pre.length ? 0 : (a.pre.length === 0 ? 1 : -1);
    }
    return cmpPre(a.pre, b.pre);
  };
  const floors = [];
  for (const comparator of llm.split('||')) {
    const m = comparator.trim().match(/^>=\s*(.+)$/);
    assert.ok(m, 'unsupported comparator in the peer range: ' + comparator.trim());
    const parsed = parseVer(m[1].trim());
    assert.ok(parsed, 'unparsable version in the peer range: ' + m[1].trim());
    // Only a comparator that itself carries a prerelease admits prereleases
    // of its own tuple; a bare x.y.z floor admits that tuple too.
    floors.push({ tuple: parsed.nums.join('.'), prerelease: parsed.pre.length > 0, parsed });
  }
  const uncovered = [];
  for (const version of PUBLISHED_DSH_LLM) {
    const v = parseVer(version);
    const admitted = floors.some((f) => {
      if (f.tuple !== v.nums.join('.')) return false;
      if (v.pre.length > 0 && !f.prerelease) return false;
      return cmpVer(v, f.parsed) >= 0;
    });
    if (!admitted) uncovered.push(version);
  }
  assert.deepStrictEqual(uncovered, [],
    'these hosts would get a permanent unmet-peer warning: ' + uncovered.join(', ') + ' — range: ' + llm);
});

test('repo: dsh.client names the current module-system package', () => {
  // @deepseek-ai/dsh-client-runtime was renamed to @deepseek-ai/dsh-client-modules
  // in DSH 0.1.2-alpha.2 — the stale name silently resolves to nothing on the
  // new line, so the boot graph never orders the module system before us.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const inject = (pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject) || [];
  assert.ok(inject.includes('@deepseek-ai/dsh-client-modules'), 'must name dsh-client-modules: ' + JSON.stringify(inject));
  assert.ok(!inject.includes('@deepseek-ai/dsh-client-runtime'), 'the pre-0.1.2 package name must be gone');
});

test('local-asr: a missing native binding degrades with a clear code', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'local-asr.js'), 'utf8');
  // Unguarded, this is an opaque MODULE_NOT_FOUND from deep inside the
  // recognizer load — a stack trace about an engine the user never chose.
  assert.ok(/catch \(cause\) \{/.test(src), 'the sherpa require must be guarded');
  assert.ok(/local-engine-unavailable/.test(src), 'a dedicated error code must be set');
});

// ---------- docs: unofficial note + SECURITY pointer ----------
const readme = fs.existsSync(path.join(ROOT, 'README.md'))
  ? fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  : '';
test('docs: README marks unofficial and points to SECURITY.md', () => {
  assert.ok(readme.includes('非官方'), 'README should mark the plugin as unofficial');
  assert.ok(readme.includes('SECURITY.md'), 'README should point to SECURITY.md');
  assert.ok(readme.includes('自动（默认）'), 'README should state the auto default engine');
});

test('scripts: lint.cjs checks syntax without spawning processes', () => {
  // execSync/child_process would flag the repo as high-risk in a source
  // scan; the same check now runs through node:vm for CJS-shaped files,
  // while the ESM lib modules are loaded by this very test suite.
  const lintSrc = fs.existsSync(path.join(ROOT, 'scripts', 'lint.cjs'))
    ? fs.readFileSync(path.join(ROOT, 'scripts', 'lint.cjs'), 'utf8')
    : '';
  assert.ok(!/child_process/.test(lintSrc), 'no child_process import');
  assert.ok(!/execSync/.test(lintSrc), 'no execSync');
  assert.ok(/node:vm/.test(lintSrc), 'syntax check must use node:vm');
});

// ---------- REAL behavioural tests for lib/host-utils.js ----------

// polishText lazy-imports @deepseek-ai/dsh-llm (an OPTIONAL peer — never
// installed by npm ci). Stub it under node_modules so the SUCCESS paths of
// polishText can be exercised for real; removed again in main().
let wroteLlmStub = false;
function ensureLlmStub() {
  const stubDir = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-llm');
  if (fs.existsSync(path.join(stubDir, 'package.json'))) return;
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '0.0.0-stub', type: 'module', exports: './index.js' }));
  fs.writeFileSync(path.join(stubDir, 'index.js'), 'export function createUserMessage(x) { return x; }\n');
  wroteLlmStub = true;
}

async function behavioural() {
  const utils = await import(pathToFileURL(path.join(ROOT, 'lib', 'host-utils.js')).href);
  const host = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href);
  const { PassThrough } = require('node:stream');
  const os = require('node:os');

  // language normalization
  test('utils: normalizeLanguageCode', () => {
    assert.strictEqual(utils.normalizeLanguageCode('zh-CN'), 'zh');
    assert.strictEqual(utils.normalizeLanguageCode('en-US'), 'en');
    assert.strictEqual(utils.normalizeLanguageCode('yue'), 'yue');
    assert.strictEqual(utils.normalizeLanguageCode('YUE'), 'yue');
    assert.strictEqual(utils.normalizeLanguageCode(''), '');
    assert.strictEqual(utils.normalizeLanguageCode('  '), '');
    assert.strictEqual(utils.normalizeLanguageCode(null), '');
    assert.strictEqual(utils.normalizeLanguageCode(undefined), '');
  });

  // body reading
  await testAsync('utils: readJsonBody parses JSON objects', async () => {
    const s = new PassThrough();
    const p = utils.readJsonBody(s);
    s.end('{"a":1,"b":"x"}');
    assert.deepStrictEqual(await p, { a: 1, b: 'x' });
  });

  await testAsync('utils: readJsonBody handles string chunks', async () => {
    const s = new PassThrough();
    const p = utils.readJsonBody(s);
    s.end('"plain-string"');
    assert.strictEqual(await p, 'plain-string');
  });

  await testAsync('utils: readJsonBody invalid JSON resolves null', async () => {
    const s = new PassThrough();
    const p = utils.readJsonBody(s);
    s.end('{oops');
    assert.strictEqual(await p, null);
  });

  await testAsync('utils: readJsonBody empty body resolves null', async () => {
    const s = new PassThrough();
    const p = utils.readJsonBody(s);
    s.end('');
    assert.strictEqual(await p, null);
  });

  await testAsync('utils: readJsonBody oversized resolves PAYLOAD_TOO_LARGE (413 path)', async () => {
    const s = new PassThrough();
    const p = utils.readJsonBody(s, 1024);
    s.end(Buffer.alloc(2048));
    assert.strictEqual(await p, utils.PAYLOAD_TOO_LARGE);
  });

  // ASR call
  await testAsync('utils: transcribeAudio success (trim, bearer header, zh language, webm file)', async () => {
    const calls = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({ text: '  你好 世界  ' }) };
    };
    try {
      const text = await utils.transcribeAudio({
        audioBase64: Buffer.from('fake-audio-bytes').toString('base64'),
        mimeType: 'audio/webm',
        language: 'zh-CN',
        settings: { asrUrl: 'https://asr.example.com/v1/audio/transcriptions', asrModel: 'whisper-large-v3', asrApiKey: 'sekret' }
      });
      assert.strictEqual(text, '你好 世界');
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].url, 'https://asr.example.com/v1/audio/transcriptions');
      assert.strictEqual(calls[0].opts.headers.authorization, 'Bearer sekret');
      const fd = calls[0].opts.body;
      assert.ok(fd instanceof FormData, 'body must be FormData');
      assert.strictEqual(fd.get('model'), 'whisper-large-v3');
      assert.strictEqual(fd.get('language'), 'zh');
      const file = fd.get('file');
      assert.ok(file instanceof Blob, 'file must be a Blob');
      assert.strictEqual(file.name, 'recording.webm');
    } finally {
      globalThis.fetch = orig;
    }
  });

  await testAsync('utils: transcribeAudio preserves 3-letter language codes (yue)', async () => {
    const calls = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, opts) => { calls.push(opts); return { ok: true, status: 200, json: async () => ({ text: 'ok' }) }; };
    try {
      await utils.transcribeAudio({ audioBase64: 'YQ==', mimeType: 'audio/mp4', language: 'yue', settings: { asrApiKey: 'k' } });
      assert.strictEqual(calls[0].body.get('language'), 'yue');
      assert.strictEqual(calls[0].body.get('file').name, 'recording.m4a');
    } finally {
      globalThis.fetch = orig;
    }
  });

  await testAsync('utils: transcribeAudio http error maps to asr-http with provider message', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid api key' } }) });
    try {
      await assert.rejects(
        utils.transcribeAudio({ audioBase64: 'YQ==', mimeType: 'audio/webm', language: '', settings: { asrApiKey: 'k' } }),
        (err) => err.code === 'asr-http' && /invalid api key/.test(err.message)
      );
    } finally {
      globalThis.fetch = orig;
    }
  });

  await testAsync('utils: transcribeAudio missing key maps to asr-key-missing', async () => {
    await assert.rejects(
      utils.transcribeAudio({ audioBase64: 'YQ==', mimeType: 'audio/webm', language: '', settings: {} }),
      (err) => err.code === 'asr-key-missing'
    );
  });

  await testAsync('utils: transcribeAudio empty audio maps to audio-empty', async () => {
    await assert.rejects(
      utils.transcribeAudio({ audioBase64: '', mimeType: 'audio/webm', language: '', settings: { asrApiKey: 'k' } }),
      (err) => err.code === 'audio-empty'
    );
  });

  await testAsync('utils: transcribeAudio empty transcript maps to asr-empty', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ text: '   ' }) });
    try {
      await assert.rejects(
        utils.transcribeAudio({ audioBase64: 'YQ==', mimeType: 'audio/webm', language: '', settings: { asrApiKey: 'k' } }),
        (err) => err.code === 'asr-empty'
      );
    } finally {
      globalThis.fetch = orig;
    }
  });

  await testAsync('utils: transcribeAudio falls back to the next provider on failure', async () => {
    const calls = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calls.push(url);
      if (url.indexOf('first') >= 0) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
      return { ok: true, status: 200, json: async () => ({ text: '  fallback ok  ' }) };
    };
    try {
      const text = await utils.transcribeAudio({
        audioBase64: 'YQ==',
        mimeType: 'audio/webm',
        language: '',
        settings: {
          asrProviders: [
            { url: 'https://first.example/v1/audio/transcriptions', model: 'm1', key: 'k1' },
            { url: 'https://second.example/v1/audio/transcriptions', model: 'm2', key: 'k2' }
          ]
        }
      });
      assert.strictEqual(text, 'fallback ok');
      assert.deepStrictEqual(calls, [
        'https://first.example/v1/audio/transcriptions',
        'https://second.example/v1/audio/transcriptions'
      ]);
    } finally {
      globalThis.fetch = orig;
    }
  });

  await testAsync('utils: transcribeAudio all providers failing aggregates errors', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.indexOf('a.example') >= 0) return { ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) };
      return { ok: false, status: 500, json: async () => ({ error: { message: 'server broke' } }) };
    };
    try {
      await assert.rejects(
        utils.transcribeAudio({
          audioBase64: 'YQ==',
          mimeType: 'audio/webm',
          language: '',
          settings: {
            asrProviders: [
              { url: 'https://a.example/v1', model: 'm', key: 'k' },
              { url: 'https://b.example/v1', model: 'm', key: 'k' }
            ]
          }
        }),
        (err) => {
          assert.strictEqual(err.code, 'asr-failed');
          assert.ok(/a\.example/.test(err.message), 'aggregated message should mention provider a: ' + err.message);
          assert.ok(/b\.example/.test(err.message), 'aggregated message should mention provider b: ' + err.message);
          return true;
        }
      );
    } finally {
      globalThis.fetch = orig;
    }
  });

  await testAsync('utils: transcribeAudio legacy single-endpoint settings still work', async () => {
    const calls = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ text: 'legacy' }) }; };
    try {
      const text = await utils.transcribeAudio({
        audioBase64: 'YQ==',
        mimeType: 'audio/webm',
        language: '',
        settings: { asrUrl: 'https://legacy.example/v1', asrModel: 'whisper-1', asrApiKey: 'oldkey' }
      });
      assert.strictEqual(text, 'legacy');
      assert.deepStrictEqual(calls, ['https://legacy.example/v1']);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test('utils: resolveAsrProviders folds legacy fields first, then the chain', () => {
    const out = utils.resolveAsrProviders({
      asrUrl: 'https://legacy.example/v1',
      asrModel: 'whisper-1',
      asrApiKey: 'oldkey',
      asrProviders: [
        { url: 'https://b.example/v1', model: 'm2', key: 'k2' },
        { url: '', model: 'skip-me', key: 'x' },
        { url: 'https://c.example/v1', model: 'm3' }
      ]
    });
    assert.strictEqual(out.length, 3);
    assert.strictEqual(out[0].url, 'https://legacy.example/v1');
    assert.strictEqual(out[0].key, 'oldkey');
    assert.strictEqual(out[1].url, 'https://b.example/v1');
    assert.strictEqual(out[1].key, 'k2');
    assert.strictEqual(out[2].url, 'https://c.example/v1');
    assert.strictEqual(out[2].key, '');
    assert.strictEqual(out[2].model, 'm3');
  });

  test('utils: resolveAsrProviders empty settings falls back to the default endpoint', () => {
    const out = utils.resolveAsrProviders({});
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.strictEqual(out[0].model, 'whisper-large-v3');
    assert.strictEqual(out[0].key, '');
  });

  test('utils: resolveAsrProviders caps the chain at MAX_ASR_PROVIDERS', () => {
    const providers = [];
    for (let i = 0; i < 10; i++) providers.push({ url: 'https://p' + i + '.example/v1', model: 'm', key: 'k' });
    const out = utils.resolveAsrProviders({ asrProviders: providers });
    assert.strictEqual(out.length, utils.MAX_ASR_PROVIDERS);
  });

  // settings round-trip
  await testAsync('utils: settings round-trip via DSH_HOME (owner-only on POSIX)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vs-'));
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = tmp;
    try {
      utils.writeSettings({ asrApiKey: 'sekret', asrUrl: 'https://x.example', asrModel: 'm' });
      const back = utils.readSettings();
      assert.strictEqual(back.asrApiKey, 'sekret');
      assert.strictEqual(back.asrModel, 'm');
      assert.strictEqual(back.asrUrl, 'https://x.example');
      if (process.platform !== 'win32') {
        const st = fs.statSync(path.join(tmp, 'voice-input.json'));
        assert.strictEqual(st.mode & 0o777, 0o600, 'settings file must be owner-only on POSIX');
      }
      fs.rmSync(path.join(tmp, 'voice-input.json'));
      assert.deepStrictEqual(utils.readSettings(), {}, 'missing settings file reads as {}');
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // trust fence
  test('utils: isTrustedApiRequest allows loopback same-origin', () => {
    const req = { headers: { host: '127.0.0.1:4400', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:4400' } };
    assert.strictEqual(utils.isTrustedApiRequest(req, []), true);
  });

  test('utils: isTrustedApiRequest allows loopback without origin (curl)', () => {
    const req = { headers: { host: 'localhost:4400' } };
    assert.strictEqual(utils.isTrustedApiRequest(req, []), true);
  });

  test('utils: isTrustedApiRequest blocks cross-site', () => {
    const req = { headers: { host: '127.0.0.1:4400', 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' } };
    assert.strictEqual(utils.isTrustedApiRequest(req, []), false);
  });

  test('utils: isTrustedApiRequest blocks origin mismatch', () => {
    const req = { headers: { host: '127.0.0.1:4400', origin: 'http://127.0.0.1:9999' } };
    assert.strictEqual(utils.isTrustedApiRequest(req, []), false);
  });

  test('utils: isTrustedApiRequest blocks missing host', () => {
    assert.strictEqual(utils.isTrustedApiRequest({ headers: {} }, []), false);
  });

  test('utils: isTrustedApiRequest honours trustedHosts for non-loopback', () => {
    const req = { headers: { host: 'dsh.lan:8080', 'sec-fetch-site': 'same-origin', origin: 'http://dsh.lan:8080' } };
    assert.strictEqual(utils.isTrustedApiRequest(req, ['dsh.lan:8080']), true);
    assert.strictEqual(utils.isTrustedApiRequest(req, []), false);
  });

  test('utils: buildTrustedHosts filters invalid entries once', () => {
    const warned = [];
    const out = utils.buildTrustedHosts(['ok.example:443', 'bad path/entry', 'ok2.example'], (m) => warned.push(m));
    assert.deepStrictEqual(out, ['ok.example:443', 'ok2.example']);
    assert.strictEqual(warned.length, 1);
  });

  test('utils: buildTrustedHosts tolerates a non-array input', () => {
    // A host that exposes no trustedHosts must not make apply() throw at
    // startup — it degrades to "loopback only", never a dead plugin.
    assert.deepStrictEqual(utils.buildTrustedHosts(undefined), []);
    assert.deepStrictEqual(utils.buildTrustedHosts(null), []);
    assert.deepStrictEqual(utils.buildTrustedHosts({}), []);
    assert.deepStrictEqual(utils.buildTrustedHosts(['localhost']), ['localhost']);
  });

  // ---- REAL behavioural tests for lib/index.js (importable offline) ----

  function mockResponse() {
    const state = { status: 0, headers: {}, body: undefined };
    const res = {
      _state: state,
      setHeader(k, v) { state.headers[k] = v; },
      writeHead(s, h) { state.status = s; if (h) Object.assign(state.headers, h); },
      end(b) { state.body = b; },
      on() {},
      get writableEnded() { return state.status !== 0; }
    };
    return res;
  }

  /** POST a JSON body through handleApi; returns { res, body(parsed) }. */
  async function post(hostModule, payload, ctx, extraHeaders) {
    const req = Object.assign(new PassThrough(), {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, extraHeaders || {})
    });
    const res = mockResponse();
    const p = hostModule.handleApi(req, res, ctx || {});
    req.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    await p;
    return { res, body: res._state.body ? JSON.parse(res._state.body) : null };
  }

  await testAsync('host: polishText keeps raw transcript when prepareCall throws', async () => {
    const ctx = { llm: { prepareCall: async () => { throw new Error('no route'); } } };
    const out = await host.polishText({ text: '嗯 好的', provider: 'p', model: 'm', ctx });
    assert.strictEqual(out, '嗯 好的');
  });

  await testAsync('host: polishText returns blank for blank text without calling llm', async () => {
    let called = false;
    const ctx = { llm: { prepareCall: async () => { called = true; throw new Error('x'); } } };
    assert.strictEqual(await host.polishText({ text: '   ', provider: 'p', model: 'm', ctx }), '');
    assert.strictEqual(called, false, 'prepareCall must not run for blank text');
  });

  await testAsync('host: polishText skips over-long text without calling llm', async () => {
    let called = false;
    const ctx = { llm: { prepareCall: async () => { called = true; throw new Error('x'); } } };
    const long = 'a'.repeat(12001);
    assert.strictEqual(await host.polishText({ text: long, provider: 'p', model: 'm', ctx }), long);
    assert.strictEqual(called, false, 'prepareCall must not run for over-long text');
  });

  await testAsync('host: polishText forwards an already-aborted client signal to the stream', async () => {
    ensureLlmStub();
    const ac = new AbortController();
    ac.abort();
    let streamSignalAborted = null;
    const ctx = { llm: { prepareCall: async () => ({ config: {}, stream: async function* ({ signal }) {
      streamSignalAborted = signal.aborted;
      yield { type: 'text-delta', text: 'hello' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } }) } };
    const out = await host.polishText({ text: 'raw', provider: 'p', model: 'm', ctx, signal: ac.signal });
    assert.strictEqual(streamSignalAborted, true, 'the stream must see an aborted signal for a client that is already gone');
    assert.strictEqual(out, 'hello');
  });

  await testAsync('host: polishText ignores non-text-delta and non-string chunks', async () => {
    ensureLlmStub();
    const ctx = { llm: { prepareCall: async () => ({ config: {}, stream: async function* () {
      yield { type: 'text-delta', text: '你好' };
      yield { type: 'tool-use', text: 'ignored' };
      yield { type: 'text-delta', text: undefined };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } }) } };
    const out = await host.polishText({ text: 'raw', provider: 'p', model: 'm', ctx });
    assert.strictEqual(out, '你好', 'only string text-delta chunks may be concatenated');
  });

  await testAsync('host: handleApi 405 for non-POST', async () => {
    const req = Object.assign(new PassThrough(), { method: 'GET', headers: {} });
    const res = mockResponse();
    await host.handleApi(req, res, {});
    assert.strictEqual(res._state.status, 405);
    assert.strictEqual(JSON.parse(res._state.body).ok, false);
  });

  await testAsync('host: handleApi 415 for non-JSON content type', async () => {
    const { res } = await post(host, { action: 'get-settings' }, {}, { 'content-type': 'text/plain' });
    assert.strictEqual(res._state.status, 415);
  });

  await testAsync('host: handleApi 400 for invalid JSON', async () => {
    const { res } = await post(host, '{oops');
    assert.strictEqual(res._state.status, 400);
  });

  await testAsync('host: handleApi 404 for unknown action', async () => {
    const { res } = await post(host, { action: 'nope' });
    assert.strictEqual(res._state.status, 404);
  });

  await testAsync('host: handleApi responds 413 with connection:close to oversized body', async () => {
    const req = Object.assign(new PassThrough(), { method: 'POST', headers: { 'content-type': 'application/json' } });
    const res = mockResponse();
    const p = host.handleApi(req, res, {});
    req.end(Buffer.alloc(25 * 1024 * 1024));
    await p;
    assert.strictEqual(res._state.status, 413, 'must answer 413 instead of hanging');
    assert.strictEqual(res._state.headers['connection'], 'close');
    assert.strictEqual(JSON.parse(res._state.body).error.code, 'payload-too-large');
  });

  await testAsync('host: handleApi get-settings exposes hasKey but never the key', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vs-'));
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = tmp;
    try {
      utils.writeSettings({ asrApiKey: 'sekret' });
      const { res } = await post(host, { action: 'get-settings' });
      assert.strictEqual(res._state.status, 200);
      const body = JSON.parse(res._state.body);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.value.hasKey, true);
      assert.ok(!JSON.stringify(body).includes('sekret'), 'key must not appear in the response');
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await testAsync('host: handleApi set-settings rejects non-http asrUrl', async () => {
    const { res } = await post(host, { action: 'set-settings', patch: { asrUrl: 'ftp://x' } });
    assert.strictEqual(res._state.status, 400);
  });

  await testAsync('host: handleApi set-settings trims values and empty deletes the key', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vs-'));
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = tmp;
    try {
      utils.writeSettings({ asrApiKey: 'old', asrUrl: 'https://a.example' });
      const { res } = await post(host, { action: 'set-settings', patch: { asrApiKey: '  new  ', asrUrl: '   ' } });
      assert.strictEqual(res._state.status, 200);
      const back = utils.readSettings();
      assert.strictEqual(back.asrApiKey, 'new');
      assert.strictEqual(back.asrUrl, undefined, 'empty asrUrl should delete the field');
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await testAsync('host: handleApi set-settings asrProviders saves chain (key absent inherits stored)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vs-'));
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = tmp;
    try {
      // Pre-existing chain with a key on the first provider.
      utils.writeSettings({ asrProviders: [{ url: 'https://a.example/v1', model: 'm1', key: 'storedkey' }] });
      // Save WITHOUT a key for that url -> must keep 'storedkey'.
      const { res } = await post(host, { action: 'set-settings', patch: { asrProviders: [{ url: 'https://a.example/v1', model: 'm1' }] } });
      assert.strictEqual(res._state.status, 200);
      const back = utils.readSettings();
      assert.strictEqual(back.asrProviders.length, 1);
      assert.strictEqual(back.asrProviders[0].key, 'storedkey', 'absent key must inherit the stored key');
      // Explicit empty key deletes it.
      const { res: res2 } = await post(host, { action: 'set-settings', patch: { asrProviders: [{ url: 'https://a.example/v1', model: 'm1', key: '' }] } });
      assert.strictEqual(res2._state.status, 200);
      const back2 = utils.readSettings();
      assert.strictEqual(back2.asrProviders[0].key, null, 'empty key deletes the stored key (null marker)');
      // New key sets it.
      const { res: res3 } = await post(host, { action: 'set-settings', patch: { asrProviders: [{ url: 'https://a.example/v1', model: 'm1', key: 'newkey' }] } });
      assert.strictEqual(res3._state.status, 200);
      assert.strictEqual(utils.readSettings().asrProviders[0].key, 'newkey');
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await testAsync('host: handleApi get-settings exposes provider view (hasKey, never the key)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vs-'));
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = tmp;
    try {
      utils.writeSettings({ asrProviders: [
        { url: 'https://a.example/v1', model: 'm1', key: 'sekret' },
        { url: 'https://b.example/v1', model: 'm2', key: '' }
      ] });
      const { res, body } = await post(host, { action: 'get-settings' });
      assert.strictEqual(res._state.status, 200);
      assert.strictEqual(body.ok, true);
      assert.ok(Array.isArray(body.value.providers), 'providers view present');
      assert.strictEqual(body.value.providers.length, 2);
      assert.strictEqual(body.value.providers[0].url, 'https://a.example/v1');
      assert.strictEqual(body.value.providers[0].hasKey, true);
      assert.strictEqual(body.value.providers[1].hasKey, false);
      assert.ok(!JSON.stringify(body.value).includes('sekret'), 'key must never be serialized');
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await testAsync('host: handleApi transcribe without key returns asr-key-missing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vs-'));
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = tmp;
    try {
      const { res } = await post(host, { action: 'transcribe', audio: Buffer.from('abc').toString('base64'), mimeType: 'audio/webm', language: 'zh-CN' });
      assert.strictEqual(res._state.status, 200);
      const body = JSON.parse(res._state.body);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.error.code, 'asr-key-missing');
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await testAsync('host: handleApi polish falls back to raw transcript on route failure', async () => {
    const ctx = { llm: { prepareCall: async () => { throw new Error('no route'); } } };
    const { res } = await post(host, { action: 'polish', text: '嗯 好的', provider: 'p', model: 'm' }, ctx);
    assert.strictEqual(res._state.status, 200);
    const body = JSON.parse(res._state.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.text, '嗯 好的');
  });

  await testAsync('host: handleApi polish requires provider and model', async () => {
    const { res } = await post(host, { action: 'polish', text: 'hi' });
    assert.strictEqual(res._state.status, 400);
  });

  await testAsync('host: handleApi list-models with empty provider list', async () => {
    const ctx = { llm: { listProviders: () => [], listModels: async () => [] } };
    const { res } = await post(host, { action: 'list-models' }, ctx);
    assert.strictEqual(res._state.status, 200);
    assert.deepStrictEqual(JSON.parse(res._state.body).value, []);
  });

  await testAsync('host: handleApi local-status reports model not ready without a model', async () => {
    // Uses the real default modelDir() — which has no model in CI — and must
    // still answer 200 with a clean shape (never 500).
    const { res } = await post(host, { action: 'local-status' });
    assert.strictEqual(res._state.status, 200);
    const body = JSON.parse(res._state.body);
    assert.strictEqual(body.ok, true);
    assert.ok(typeof body.value.modelReady === 'boolean');
    assert.ok(typeof body.value.downloading === 'boolean');
  });

  // ---- REAL behavioural tests for lib/local-asr.js (pure, no model needed) ----
  const local = await import(pathToFileURL(path.join(ROOT, 'lib', 'local-asr.js')).href);

  test('local-asr: cleanupSenseVoiceText strips metadata tokens', () => {
    assert.strictEqual(local.cleanupSenseVoiceText('<|zh|><|NEUTRAL|><|Speech|><|withitn|>你好世界'), '你好世界');
    assert.strictEqual(local.cleanupSenseVoiceText('<|en|><|HAPPY|>Hello world'), 'Hello world');
    assert.strictEqual(local.cleanupSenseVoiceText('  无标记文本  '), '无标记文本');
    assert.strictEqual(local.cleanupSenseVoiceText(null), '');
    assert.strictEqual(local.cleanupSenseVoiceText(undefined), '');
  });

  test('local-asr: base64ToFloat32 roundtrips little-endian f32 PCM', () => {
    const src = new Float32Array([0.0, -1.0, 1.0, 0.5, -0.5, 3.14]);
    const b64 = Buffer.from(src.buffer, src.byteOffset, src.byteLength).toString('base64');
    const out = local.base64ToFloat32(b64);
    assert.strictEqual(out.length, src.length);
    for (let i = 0; i < src.length; i++) assert.ok(Math.abs(out[i] - src[i]) < 1e-6);
    assert.strictEqual(local.base64ToFloat32('').length, 0);
    assert.strictEqual(local.base64ToFloat32(null).length, 0);
    // trailing partial sample (3 bytes) is truncated, not crashed
    assert.strictEqual(local.base64ToFloat32(Buffer.from([1, 2, 3]).toString('base64')).length, 0);
  });

  test('local-asr: modelDir honours DSH_HOME', () => {
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = 'C:/fake-home';
    try {
      const dir = local.modelDir();
      // path.join uses the platform separator — check both forms.
      assert.ok(dir.startsWith('C:/fake-home') || dir.startsWith('C:\\fake-home'), 'should be under DSH_HOME: ' + dir);
      assert.ok(/voice[\\/]sensevoice$/.test(dir), 'should end with voice/sensevoice: ' + dir);
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    }
  });

  test('local-asr: getDownloadState returns a clean shape', () => {
    const s = local.getDownloadState();
    assert.strictEqual(typeof s.running, 'boolean');
    assert.strictEqual(typeof s.error, 'string');
    assert.strictEqual(typeof s.progress.file, 'string');
    assert.strictEqual(typeof s.progress.done, 'number');
  });

  test('local-asr: disposeRecognizer is safe to call', () => {
    local.disposeRecognizer();
  });

  await testAsync('local-asr: concurrent ensureRecognizer shares ONE model load', async () => {
    // Regression: two overlapping transcriptions used to each construct an
    // OfflineRecognizer — the ~230 MB model was loaded into memory TWICE.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-rec-'));
    // Fixtures must clear the plausibility floor in modelReady().
    fs.writeFileSync(path.join(dir, 'model.int8.onnx'), Buffer.alloc(local.MIN_MODEL_BYTES));
    fs.writeFileSync(path.join(dir, 'tokens.txt'), 'a b c'.padEnd(local.MIN_TOKENS_BYTES, ' '));
    local.disposeRecognizer();
    let loads = 0;
    const loader = async () => { loads++; await new Promise((r) => setTimeout(r, 50)); return { fake: true }; };
    try {
      const [a, b, c] = await Promise.all([
        local.ensureRecognizer(dir, loader),
        local.ensureRecognizer(dir, loader),
        local.ensureRecognizer(dir, loader)
      ]);
      assert.strictEqual(loads, 1, 'concurrent loads must share one promise, got ' + loads);
      assert.strictEqual(a, b);
      assert.strictEqual(b, c);
      await local.ensureRecognizer(dir, loader); // cached singleton — still one load
      assert.strictEqual(loads, 1);
    } finally {
      local.disposeRecognizer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await testAsync('local-asr: failed recognizer load clears the memo so retry works', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-rec-fail-'));
    // Fixtures must clear the plausibility floor in modelReady().
    fs.writeFileSync(path.join(dir, 'model.int8.onnx'), Buffer.alloc(local.MIN_MODEL_BYTES));
    fs.writeFileSync(path.join(dir, 'tokens.txt'), 'a b c'.padEnd(local.MIN_TOKENS_BYTES, ' '));
    local.disposeRecognizer();
    let loads = 0;
    const loader = async () => { loads++; if (loads === 1) throw new Error('boom'); return { ok: true }; };
    try {
      await assert.rejects(() => local.ensureRecognizer(dir, loader), /boom/);
      const rec = await local.ensureRecognizer(dir, loader);
      assert.deepStrictEqual(rec, { ok: true });
      assert.strictEqual(loads, 2, 'a failure must not poison later loads');
    } finally {
      local.disposeRecognizer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await testAsync('local-asr: model-not-ready when files are missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-rec-empty-'));
    local.disposeRecognizer();
    try {
      await assert.rejects(
        () => local.ensureRecognizer(dir, async () => ({})),
        (e) => e && e.code === 'model-not-ready'
      );
    } finally {
      local.disposeRecognizer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await testAsync('local-asr: a truncated download is rejected, never published', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-trunc-'));
    const GOOD = 'http://trunc-mirror.invalid';
    let cancelled = 0;
    const realFetch = globalThis.fetch;
    // The body ends early while content-length promises more. The read loop
    // only sees `done`, which used to rename the partial file into place — and
    // because startModelDownload skips any non-empty file, that broken model
    // was permanent.
    globalThis.fetch = async (url) => {
      const u = String(url);
      const isTokens = u.endsWith('/tokens.txt');
      const body = isTokens ? [Buffer.from('a b c')] : [Buffer.alloc(1024, 1)];
      const promised = isTokens ? 5 : 256 * 1024;
      let i = 0;
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(promised) : null) },
        body: {
          getReader: () => ({
            read: async () => (i < body.length ? { done: false, value: body[i++] } : { done: true, value: undefined }),
            // A real ReadableStreamDefaultReader always has cancel(); the
            // mirror-failover path calls it to stop an abandoned transfer.
            cancel: async () => { cancelled++; }
          })
        }
      };
    };
    try {
      await local.startModelDownload(dir, [GOOD]);
      for (let i = 0; i < 200 && local.getDownloadState().running; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const state = local.getDownloadState();
      assert.strictEqual(state.running, false);
      assert.ok(/truncated/.test(state.error), 'the short read must be reported: ' + state.error);
      assert.strictEqual(fs.existsSync(path.join(dir, 'model.int8.onnx')), false,
        'a partial model must never be published');
      assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.part')), [], 'no junk left');
      assert.ok(cancelled > 0, 'an abandoned mirror body must be cancelled, not left streaming');
    } finally {
      globalThis.fetch = realFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await testAsync('local-asr: modelReady rejects an implausibly small model', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ready-'));
    try {
      fs.writeFileSync(path.join(dir, 'tokens.txt'), 'a b c');
      fs.writeFileSync(path.join(dir, 'model.int8.onnx'), Buffer.alloc(2048, 0));
      assert.strictEqual(await local.modelReady(dir), false, 'a truncated model must not report ready');
      assert.strictEqual(await local.modelReady(dir, 1024, 1), true, 'the floor must be injectable');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  await testAsync('local-asr: a stubbed model file is refetched, not trusted forever', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-stub-'));
    // A download that died early leaves a few bytes behind. The skip test used
    // to be "non-empty ⇒ keep", so that stub was trusted forever: modelReady()
    // kept answering false while every retry skipped the one file that needed
    // refetching, and the user saw an endless download that never finished.
    fs.writeFileSync(path.join(dir, 'tokens.txt'), 'x');
    const realFetch = globalThis.fetch;
    const served = Buffer.from('t'.repeat(200));
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(served.length) : null) },
      body: {
        getReader: () => {
          let sent = false;
          return {
            read: async () => {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: served };
            },
            cancel: async () => {}
          };
        }
      }
    });
    try {
      await local.startModelDownload(dir, ['http://stub-mirror.invalid']);
      for (let i = 0; i < 200 && local.getDownloadState().running; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.strictEqual(local.getDownloadState().running, false);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'tokens.txt'), 'utf8'), served.toString(),
        'the stub must be replaced by a freshly downloaded tokens.txt');
    } finally {
      globalThis.fetch = realFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await testAsync('local-asr: concurrent download requests start exactly one transfer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-race-'));
    const realFetch = globalThis.fetch;
    const served = Buffer.from('m'.repeat(200));
    let transfers = 0;
    globalThis.fetch = async () => {
      transfers++;
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(served.length) : null) },
        body: {
          getReader: () => {
            let sent = false;
            return {
              read: async () => {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: served };
              },
              cancel: async () => {}
            };
          }
        }
      };
    };
    try {
      // Two callers (two browser tabs, or the settings page racing the hotkey)
      // reach local-download before the first one's readiness probe resolves.
      // Both used to pass the running guard and interleave into the same .part.
      const first = local.startModelDownload(dir, ['http://race.invalid']);
      const second = local.startModelDownload(dir, ['http://race.invalid']);
      const [a, b] = await Promise.all([first, second]);
      assert.strictEqual([a, b].filter((r) => r.started).length, 1,
        'exactly one caller may start the transfer');
      for (let i = 0; i < 200 && local.getDownloadState().running; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.strictEqual(transfers, 2, 'tokens + model must be fetched once each, got ' + transfers);
    } finally {
      globalThis.fetch = realFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await testAsync('local-asr: an already-aborted request never reaches the decode queue', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => local.transcribePcm(new Float32Array(1600), 16000, path.join(os.tmpdir(), 'vs-none'), controller.signal),
      (error) => error.code === 'asr-aborted'
    );
  });

  await testAsync('local-asr: cleanStaleParts removes only .part/.part.fail', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-clean-'));
    fs.writeFileSync(path.join(dir, 'model.int8.onnx.part'), 'x');
    fs.writeFileSync(path.join(dir, 'model.int8.onnx.part.fail'), 'x');
    fs.writeFileSync(path.join(dir, 'tokens.txt'), 'keep');
    try {
      assert.strictEqual(await local.cleanStaleParts(dir), 2);
      assert.deepStrictEqual(fs.readdirSync(dir), ['tokens.txt']);
      assert.strictEqual(await local.cleanStaleParts(path.join(dir, 'missing')), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await testAsync('local-asr: startModelDownload falls back across mirrors, no junk left', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-dl-'));
    const payload = Buffer.alloc(256 * 1024, 7); // chunked to exercise the stream loop
    // Mock the global fetch instead of spinning up real HTTP servers: the first
    // mirror always 404s, the second serves tokens.txt + the model in chunks.
    // Deterministic, no sockets/ports — and no node:http anywhere in the repo.
    const BAD = 'http://bad-mirror.invalid';
    const GOOD = 'http://good-mirror.invalid';
    const step = 32 * 1024;
    const chunks = [];
    for (let off = 0; off < payload.length; off += step) chunks.push(payload.subarray(off, off + step));

    function fakeResponse(status, bodyChunks, contentLength) {
      let i = 0;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(contentLength ?? '') : null) },
        body: {
          getReader: () => ({
            read: async () => (i < bodyChunks.length ? { done: false, value: bodyChunks[i++] } : { done: true, value: undefined }),
            cancel: async () => {}
          })
        }
      };
    }

    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith(BAD)) return fakeResponse(404, [], 0);
      if (u.endsWith('/tokens.txt')) return fakeResponse(200, [Buffer.from('a b c')], 5);
      if (u.endsWith('/model.int8.onnx')) return fakeResponse(200, chunks, payload.length);
      return fakeResponse(404, [], 0);
    };
    try {
      const mirrors = [BAD, GOOD];
      const start = await local.startModelDownload(dir, mirrors);
      assert.strictEqual(start.ok, true);
      assert.strictEqual(start.started, true);
      for (let i = 0; i < 200 && local.getDownloadState().running; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const state = local.getDownloadState();
      assert.strictEqual(state.running, false);
      assert.strictEqual(state.error, '');
      // The fixture payload is far below the real ~228 MB model: opt out of
      // the plausibility floor this test does not exercise.
      assert.strictEqual(await local.modelReady(dir, 1, 1), true);
      assert.strictEqual(fs.statSync(path.join(dir, 'model.int8.onnx')).size, payload.length);
      const junk = fs.readdirSync(dir).filter((f) => f.includes('.part'));
      assert.deepStrictEqual(junk, [], 'no .part/.part.fail junk left: ' + junk.join(','));
    } finally {
      globalThis.fetch = realFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- hot words / regex replacement table ----
  test('utils: parseHotwords literal + comments + blanks', () => {
    const p = utils.parseHotwords('# 注释行\n\n中国=我果|窝果\nDeepSeek=deep seek\n');
    assert.strictEqual(p.errors.length, 0);
    assert.strictEqual(p.rules.length, 2);
    assert.deepStrictEqual(p.rules[0], { kind: 'literal', wrongs: ['我果', '窝果'], right: '中国' });
    assert.deepStrictEqual(p.rules[1], { kind: 'literal', wrongs: ['deep seek'], right: 'DeepSeek' });
  });

  test('utils: parseHotwords regex form with flags and escaped slashes', () => {
    const p = utils.parseHotwords('/老\\s*师/老师/gi\n/a\\/b/x\n/[a-z]+/N/g\n/尾部无flags的规则/x/');
    assert.strictEqual(p.errors.length, 0, JSON.stringify(p.errors));
    assert.deepStrictEqual(p.rules[0], { kind: 'regex', source: '老\\s*师', flags: 'gi', replacement: '老师' });
    assert.deepStrictEqual(p.rules[1], { kind: 'regex', source: 'a/b', flags: '', replacement: 'x' });
    assert.deepStrictEqual(p.rules[2], { kind: 'regex', source: '[a-z]+', flags: 'g', replacement: 'N' });
    assert.deepStrictEqual(p.rules[3], { kind: 'regex', source: '尾部无flags的规则', flags: '', replacement: 'x' });
  });

  test('utils: parseHotwords collects per-line errors instead of throwing', () => {
    const p = utils.parseHotwords('没有等号\n/=空替换\n/[/x/g\n/坏(?P<x>)/x/g\n中国=空\n=更糟');
    assert.strictEqual(p.rules.length, 1, 'the one valid rule still loads');
    assert.deepStrictEqual(p.rules[0], { kind: 'literal', wrongs: ['空'], right: '中国' });
    assert.strictEqual(p.errors.length, 5);
    assert.strictEqual(p.errors[0].line, 1);
    assert.strictEqual(p.errors[1].line, 2);
  });

  test('utils: parseHotwords caps the rule count', () => {
    const lines = [];
    for (let i = 0; i < utils.MAX_HOTWORD_RULES + 5; i++) lines.push('词' + i + '=错' + i);
    const p = utils.parseHotwords(lines.join('\n'));
    assert.strictEqual(p.rules.length, utils.MAX_HOTWORD_RULES);
    assert.strictEqual(p.errors.length, 1);
  });

  test('utils: applyHotwords literal is case-insensitive and replaces all', () => {
    const p = utils.parseHotwords('OpenAI=open ai|OPENAI2');
    assert.strictEqual(utils.applyHotwords('open ai 和 OPENAI2 和 open ai', p.rules), 'OpenAI 和 OpenAI 和 OpenAI');
    assert.strictEqual(utils.applyHotwords('', p.rules), '');
    assert.strictEqual(utils.applyHotwords('无匹配', p.rules), '无匹配');
    assert.strictEqual(utils.applyHotwords('文本', []), '文本');
  });

  test('utils: applyHotwords regex supports $1 substitution and ordering', () => {
    const p = utils.parseHotwords('/姓名[:：]\\s*/姓名：/g\n/\\{([^}]+)\\}/【$1】/g');
    assert.strictEqual(utils.applyHotwords('姓名: 张三 {测试}', p.rules), '姓名：张三 【测试】');
  });
  test('utils: a regex hot-word rule without g still fixes every occurrence', () => {
    // /错词/对词/i is the JS/sed habit, and the README shows flagless examples.
    // String.replace semantics replaced only the FIRST match, silently — for
    // exactly the tokens a replacement table exists to fix.
    const p = utils.parseHotwords('/C\\+\\+/C++/');
    assert.strictEqual(utils.applyHotwords('我用 C++ 和 C++ 写代码', p.rules), '我用 C++ 和 C++ 写代码');
    const q = utils.parseHotwords('/苹菓/苹果/i');
    assert.strictEqual(utils.applyHotwords('苹菓 和 苹菓', q.rules), '苹果 和 苹果');
    // The flagless form is unambiguous: every occurrence.
    const r = utils.parseHotwords('/错词/对词/');
    assert.strictEqual(utils.applyHotwords('错词 和 错词', r.rules), '对词 和 对词');
  });

  test('utils: localPolish does not append a terminator after a closing mark', () => {
    assert.strictEqual(utils.localPolish('已完成；'), '已完成；');
    assert.strictEqual(utils.localPolish('他说：“好”'), '他说：“好”');
    assert.strictEqual(utils.localPolish('第一，'), '第一，');
    // A bare statement still gets one.
    assert.strictEqual(utils.localPolish('你好'), '你好。');
    assert.strictEqual(utils.localPolish('hello'), 'hello.');
  });

  await testAsync('host: get-settings survives a non-string asrApiKey', async () => {
  await testAsync('host: get-settings survives a non-string asrApiKey', async () => {
    // A hand-edited voice-input.json with a non-string key was the only
    // unguarded read in the settings view: it threw out of the handler, the
    // 500 made fetchSettings() return null, and the whole 语音输入 row rendered
    // blank with no error — while transcription itself kept working.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-key-'));
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = tmp;
    fs.writeFileSync(path.join(tmp, 'voice-input.json'), JSON.stringify({ asrApiKey: 123, asrUrl: 'https://asr.example/v1' }));
    try {
      const { res, body } = await post(host, { action: 'get-settings' });
      assert.strictEqual(res._state.status, 200, 'a bad settings file must not 500 the settings view');
      assert.strictEqual(body.value.hasKey, false);
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
    // Format is 正确=错误: rule 1 fixes 甲→乙, rule 2 then fixes 乙→丙.
    const p = utils.parseHotwords('乙=甲\n丙=乙');
    assert.strictEqual(utils.applyHotwords('甲', p.rules), '丙');
  });

  test('utils: resolvePolishPrompt default vs custom', () => {
    assert.strictEqual(utils.resolvePolishPrompt({}), utils.DEFAULT_POLISH_PROMPT);
    assert.strictEqual(utils.resolvePolishPrompt(null), utils.DEFAULT_POLISH_PROMPT);
    assert.strictEqual(utils.resolvePolishPrompt({ polishPrompt: '   ' }), utils.DEFAULT_POLISH_PROMPT);
    assert.strictEqual(utils.resolvePolishPrompt({ polishPrompt: ' 自定义提示词 ' }), '自定义提示词');
    assert.ok(utils.DEFAULT_POLISH_PROMPT.includes('口头禅'), 'default prompt keeps the built-in behaviour');
  });

  test('utils: localPolish strips fillers and normalises whitespace', () => {
    assert.strictEqual(utils.localPolish('嗯嗯 我觉得 呃 这个 很好用'), '我觉得 这个 很好用。');
    assert.strictEqual(utils.localPolish('就是就是 那个那个 然后呢 开始'), '开始。');
    assert.strictEqual(utils.localPolish('Hello 嗯 world'), 'Hello world.');
    assert.strictEqual(utils.localPolish('   '), '');
    assert.strictEqual(utils.localPolish(null), '');
    assert.strictEqual(utils.localPolish(123), '');
  });

  test('utils: localPolish keeps content words and existing punctuation', () => {
    assert.strictEqual(utils.localPolish('好了。'), '好了。');
    assert.strictEqual(utils.localPolish('这个很好，那个也不错！'), '这个很好，那个也不错！');
    assert.strictEqual(utils.localPolish('好啊'), '好啊。');
  });

  await testAsync('utils: loadHotwords reads $DSH_HOME/voice/hot.txt with cache', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vs-hw-'));
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = tmp;
    utils.clearHotwordsCache();
    try {
      // Missing file = no rules, no error.
      let hw = utils.loadHotwords();
      assert.strictEqual(hw.rules.length, 0);
      assert.strictEqual(hw.errors.length, 0);
      // Create the file — picked up (different signature).
      const file = path.join(tmp, 'voice', 'hot.txt');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '中国=我果\n');
      hw = utils.loadHotwords();
      assert.strictEqual(hw.rules.length, 1);
      assert.ok(hw.path.endsWith('hot.txt'), 'path should point at hot.txt: ' + hw.path);
      // Change content with a different size — cache must invalidate.
      fs.writeFileSync(file, '中国=我果\nDeepSeek=deep seek\n');
      hw = utils.loadHotwords();
      assert.strictEqual(hw.rules.length, 2);
      // Bad line surfaces as an error, good rules still load.
      fs.writeFileSync(file, '中国=我果\n坏行\n');
      hw = utils.loadHotwords();
      assert.strictEqual(hw.rules.length, 1);
      assert.strictEqual(hw.errors.length, 1);
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
      utils.clearHotwordsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await testAsync('host: handleApi transcribe applies the hot-word table', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vs-hwt-'));
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = tmp;
    utils.clearHotwordsCache();
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ text: '我果的项目是 deep seek' }) });
    try {
      utils.writeSettings({ asrApiKey: 'k', asrUrl: 'https://asr.example/v1' });
      const file = path.join(tmp, 'voice', 'hot.txt');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '中国=我果\nDeepSeek=deep seek\n');
      const { res, body } = await post(host, { action: 'transcribe', audio: Buffer.from('abc').toString('base64'), mimeType: 'audio/webm', language: '' });
      assert.strictEqual(res._state.status, 200);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.text, '中国的项目是 DeepSeek');
    } finally {
      globalThis.fetch = orig;
      if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
      utils.clearHotwordsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await testAsync('host: handleApi set-settings saves/clears polishPrompt (cap 400)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vs-pp-'));
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = tmp;
    try {
      const { res } = await post(host, { action: 'set-settings', patch: { polishPrompt: '  自定义提示词\n第二行  ' } });
      assert.strictEqual(res._state.status, 200);
      assert.strictEqual(utils.readSettings().polishPrompt, '自定义提示词\n第二行');
      // Empty string deletes the field (back to the built-in default).
      await post(host, { action: 'set-settings', patch: { polishPrompt: '   ' } });
      assert.strictEqual(utils.readSettings().polishPrompt, undefined);
      // Over-long prompt is rejected with 400.
      const { res: res3 } = await post(host, { action: 'set-settings', patch: { polishPrompt: 'a'.repeat(utils.MAX_POLISH_PROMPT_CHARS + 1) } });
      assert.strictEqual(res3._state.status, 400);
      // get-settings exposes the current custom prompt (or "").
      utils.writeSettings({ polishPrompt: '自定义' });
      const { body } = await post(host, { action: 'get-settings' });
      assert.strictEqual(body.value.polishPrompt, '自定义');
      assert.ok(body.value.hotwords && typeof body.value.hotwords.path === 'string');
      assert.strictEqual(typeof body.value.hotwords.rules, 'number');
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── 0.4.4 regressions ─────────────────────────────────────────────────────
  // Every test below reproduces a bug that shipped in 0.4.3 and that the
  // existing 133 tests did NOT catch. They are the point of this release.

  test('utils: applyHotwords literal survives regex metacharacters', () => {
    // escapeRegExp's replacement argument had been clobbered by a stray
    // find-and-replace ("\\$&" -> a section-header comment). The result was
    // still a VALID regex, so nothing ever threw — the rule just silently
    // stopped matching, which is precisely what a hot-word table is for
    // (C++, 3.14, Node.js, C#).
    const p = utils.parseHotwords('对=3.14\n修正=C++\n括号=(a)');
    assert.strictEqual(p.errors.length, 0);
    assert.strictEqual(utils.applyHotwords('价格是3.14', p.rules), '价格是对');
    assert.strictEqual(utils.applyHotwords('C++ 很快', p.rules), '修正 很快');
    assert.strictEqual(utils.applyHotwords('这是(a)结尾', p.rules), '这是括号结尾');
    // "." must stay a literal dot, not "any character".
    assert.strictEqual(utils.applyHotwords('3x14', p.rules), '3x14');
  });

  await testAsync('utils: a key-less multi-provider chain still reports asr-key-missing', async () => {
    const settings = {
      asrProviders: [
        { url: 'https://a.example/v1/audio/transcriptions', model: 'm', key: '' },
        { url: 'https://b.example/v1/audio/transcriptions', model: 'm', key: '' }
      ]
    };
    let code = null;
    try {
      await utils.transcribeAudio({
        audioBase64: Buffer.from('x').toString('base64'),
        mimeType: 'audio/webm', language: '', settings
      });
    } catch (e) { code = e && e.code; }
    // Was "asr-failed" as soon as there were 2+ rows, so the client never
    // showed its "configure your API key" guidance.
    assert.strictEqual(code, 'asr-key-missing');
  });

  await testAsync('utils: an aborted client stops the ASR failover chain', async () => {
    const settings = {
      asrProviders: [
        { url: 'https://a.example/v1/audio/transcriptions', model: 'm', key: 'k1' },
        { url: 'https://b.example/v1/audio/transcriptions', model: 'm', key: 'k2' }
      ]
    };
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const realFetch = global.fetch;
    global.fetch = async () => { calls++; throw new Error('must not be reached'); };
    try {
      let code = null;
      try {
        await utils.transcribeAudio({
          audioBase64: Buffer.from('x').toString('base64'),
          mimeType: 'audio/webm', language: '', settings, signal: ac.signal
        });
      } catch (e) { code = e && e.code; }
      assert.strictEqual(code, 'asr-aborted');
      assert.strictEqual(calls, 0, 'no provider may be contacted after the client hung up');
    } finally {
      global.fetch = realFetch;
    }
  });

  await testAsync('local-asr: a failing .part write is reported, not thrown at the process', async () => {
    const asr = await import(pathToFileURL(path.join(ROOT, 'lib', 'local-asr.js')).href);
    for (let i = 0; i < 200 && asr.getDownloadState().running; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-dl-'));
    // A DIRECTORY sitting where the .part file must go: createWriteStream
    // emits "error" asynchronously. With no lifetime 'error' listener that
    // was an UNCAUGHT exception — it killed the whole host process instead of
    // failing over to the next mirror.
    fs.mkdirSync(path.join(tmp, 'tokens.txt.part'));
    const realFetch = global.fetch;
    global.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    try {
      const started = await asr.startModelDownload(tmp, ['https://mirror.invalid/a']);
      assert.strictEqual(started.ok, true);
      for (let i = 0; i < 200 && asr.getDownloadState().running; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const state = asr.getDownloadState();
      assert.strictEqual(state.running, false);
      assert.ok(state.error !== '', 'the write failure must surface as downloadState.error');
    } finally {
      global.fetch = realFetch;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('client: cloudHasKey is declared before it is used', () => {
    // An undefined cloudHasKey threw ReferenceError while rendering the
    // settings row — for exactly the users who need to configure a key.
    const decl = clientSrc.indexOf('const cloudHasKey =');
    const use = clientSrc.indexOf('cloudHasKey ? ""');
    assert.ok(decl !== -1, 'cloudHasKey must be declared');
    assert.ok(use !== -1 && decl < use, 'the declaration must precede the use');
  });

  test('client: startRecording guards re-entry before the getUserMedia await', () => {
    // "recording" only flips true AFTER getUserMedia resolves, so a second Alt
    // tap during the permission prompt started a second stream + recorder and
    // leaked the first one's tracks — the microphone stayed live.
    assert.ok(/let startPending = false;/.test(clientSrc));
    assert.ok(/if \(recording \|\| startPending\) return false;/.test(clientSrc));
    assert.ok(/startPending = true;/.test(clientSrc));
    assert.ok(/finally \{\s*startPending = false;/.test(clientSrc));
  });

  test('client: a preview is only rolled back while the composer still holds it', () => {
    // recDraftBase is initialised to "", so "!== undefined" was ALWAYS true: a
    // failed cloud transcription silently wiped whatever the user typed while
    // the recording was being transcribed. The guard is now stronger — the
    // rollback compares the composer against the span we actually wrote, so a
    // draft the user edited mid-recording (or already sent) is never clobbered.
    assert.ok(!/if \(recDraftBase !== undefined\) setDraftText/.test(clientSrc),
      'the unconditional rollback must be gone');
    assert.ok(/function rollbackPreview\(baseline\)/.test(clientSrc));
    assert.ok(/draftText\(\) === previewSpanText/.test(clientSrc), 'the rollback must compare the live composer');
    const gated = clientSrc.match(/rollbackPreview\(recDraftBase\);/g) || [];
    assert.ok(gated.length >= 3, 'every failure path must go through rollbackPreview');
  });

  test('client: the final transcript replaces the live preview span instead of appending', () => {
    // The old branch also required a draft channel; without one the preview
    // landed in the textarea through the DOM fallback and the final transcript
    // was appended on top of it, duplicating the text. commitTranscript keys
    // off the span we wrote, and appends when the user changed the draft.
    assert.ok(!/effectiveEngine\(\) === "local" && draftChannel/.test(clientSrc),
      'the insert decision must not depend on the draft channel');
    assert.ok(/const rebuild = previewSpanText !== null && current === previewSpanText;/.test(clientSrc));
    assert.ok(/rebuild \? baseline \+ sep\(baseline\) \+ finalText : current \+ sep\(current\) \+ finalText/.test(clientSrc),
      'an edited draft must be appended to, not replaced');
    assert.ok(clientSrc.includes('commitTranscript(recDraftBase, text)'));
  });

  test('client: Web Speech final commits through the same baseline-aware path', () => {
    // The no-channel fallback used to append the final transcript AFTER the
    // interim already written into the textarea — duplicated text. Both engines
    // now commit through commitTranscript, which never depends on the channel.
    assert.ok(!/insertTranscript\(finalText\)/.test(clientSrc), 'the append-after-interim path must be gone');
    assert.ok(clientSrc.includes('commitTranscript(wsDraftBase, finalText)'));
    assert.ok(!/function insertTranscript/.test(clientSrc), 'the dead whole-draft appender must be gone');
  });

  test('client: Web Speech "auto" language follows the browser', () => {
    // readLanguage() || "zh-CN" made every English browser transcribe as
    // Chinese; "auto" must fall back to navigator.language instead.
    assert.ok(/recognition\.lang = readLanguage\(\) \|\| \(typeof navigator/.test(clientSrc));
    assert.ok(clientSrc.includes('navigator.language'));
  });

  test('client: recording auto-stops at the per-engine length cap', () => {
    // The local engine uploads raw 16 kHz float32 PCM: past ~4.7 min the
    // request body exceeds the host's 24 MB cap and fails with 413 mid-flow.
    assert.ok(/LOCAL_MAX_RECORDING_MS = 260_000/.test(clientSrc));
    assert.ok(/CLOUD_MAX_RECORDING_MS = 600_000/.test(clientSrc));
    assert.ok(/recordingCapTimer = setTimeout/.test(clientSrc));
    assert.ok(clientSrc.includes('已达最长录音时长，自动转写'));
  });

  test('client: releasing a hold with a modifier still down ends the recording', () => {
    // Alt+Shift is the Windows input-language switch: the user is holding Alt
    // exactly when Shift goes down, and reusing the keydown matcher (which
    // requires !shiftKey) left holdActive stuck and the microphone live until
    // the length cap — up to 10 minutes of ambient audio then transcribed.
    assert.ok(/function matchesHoldRelease[\s\S]{0,500}token === parsed\.key/.test(clientSrc),
      'the release path must end whenever the trigger key comes up, regardless of any other modifier held');
  });

  test('client: a throwing recorder.start() releases the microphone', () => {
    // start() throws when the stream died between getUserMedia and here;
    // unguarded, no onstop would ever release the stream and the next tap
    // opened a second one on top of the leak.
    assert.ok(/try \{\s*recorder\.start\(1000\);\s*\} catch \(error\) \{/.test(clientSrc));
    assert.ok(/catch \(error\) \{[\s\S]{0,260}track\.stop\(\)[\s\S]{0,120}stream = null;/.test(clientSrc));
  });

  test('client: an empty local transcript is not reported as inserted', () => {
    // The local route answers ok:true with text:"" for silence; committing
    // that said "✅ 已插入" while inserting nothing, plus a stray space.
    assert.ok(/if \(typeof result\.text !== "string" \|\| result\.text\.trim\(\) === ""\)/.test(clientSrc));
    assert.ok(/未识别到文字（请靠近麦克风再说一次）/.test(clientSrc));
  });

  test('client: saving the cloud chain retires the legacy single-endpoint fields', () => {
    // The host folds asrUrl/asrApiKey back in as provider #1 whenever present,
    // so leaving them behind duplicated row #1 on every save and made
    // "清除已保存 Key" leave the folded key still authenticating.
    const calls = clientSrc.match(/saveSettings\(\{ asrProviders: chain[^}]*\}\)/g) || [];
    assert.strictEqual(calls.length, 2, 'save and clear-key are the two writers');
    for (const call of calls) {
      assert.ok(call.includes('asrUrl: null') && call.includes('asrApiKey: null'),
        'the legacy fields must be deleted with the chain: ' + call);
    }
  });

  test('client: the add-provider button stops at the host cap', () => {
    // Rows past MAX_ASR_PROVIDERS are dropped when saving, so offering them
    // produced a row that reported "已保存", never ran, and vanished on reload.
    assert.ok(/const MAX_ASR_PROVIDERS = 4;/.test(clientSrc));
    assert.ok(/providers\.length < MAX_ASR_PROVIDERS \?/.test(clientSrc));
    assert.ok(/prev\.length >= MAX_ASR_PROVIDERS \? prev :/.test(clientSrc));
  });

  test('client: a missing onend cannot wedge the recorder', () => {
    // SpeechRecognition.onend is not guaranteed after stop(); without a
    // watchdog the pill sat on "处理中…" and every later Alt tap re-entered
    // the same dead stop() until the page was reloaded.
    assert.ok(/const WS_STOP_WATCHDOG_MS = 12_000;/.test(clientSrc));
    assert.ok(/wsStopWatchdog = setTimeout\(\(\) => \{[\s\S]{0,220}finishWebSpeech\(\);/.test(clientSrc));
    assert.ok(/wsStopWatchdog !== null\) \{ clearTimeout\(wsStopWatchdog\); wsStopWatchdog = null; \}/.test(clientSrc),
      'onend must clear the watchdog');
  });

  test('client: losing window focus cancels a tap-mode recording', () => {
    // Alt+Tab starts the recording on the Alt keydown, then the window
    // blurs — the mic must not stay hot and no text may be inserted.
    assert.ok(/let discardWsOnEnd = false;/.test(clientSrc) && /let discardOnStop = false;/.test(clientSrc));
    assert.ok(/function onWindowBlur\(\)[\s\S]{0,420}stopWebSpeech\(\);/.test(clientSrc));
    assert.ok(/function onWindowBlur\(\)[\s\S]{0,560}stopRecording\(\);/.test(clientSrc));
  });

  test('client: tap-mode start clears a stale holdStopPending', () => {
    // A hold-mode release that landed before an async start finished — and
    // that start then failed (model download) — left holdStopPending set;
    // the next tap recording was stopped the instant it started.
    const block = clientSrc.match(/function toggleRecording\(\)[\s\S]{0,800}?return;/);
    assert.ok(block && block[0].includes('holdStopPending = false;'),
      'a stale hold-stop marker must not kill the next tap recording');
  });

  test('client: the settings prompt textarea is excluded from the composer fallback', () => {
    // Without the exclusion the DOM fallback could grab the polish-prompt
    // box on the settings page and insert the transcript there.
    const tagged = (clientSrc.match(/data-voice-scribe-setting/g) || []).length;
    assert.ok(tagged >= 2, 'the settings textarea must be tagged AND excluded in findComposerEditor');
    assert.ok(clientSrc.includes("el.closest('[data-voice-scribe-setting=\"1\"]')"), 'the fallback must skip tagged textareas');
  });

  test('client: the polish toggle is actually reachable (model picker writes POLISH_MODEL_KEY)', () => {
  // readPolishModel() only ever read localStorage: NOTHING wrote the key, so
  // "polish enabled" produced the raw transcript forever and the custom prompt
  // was inert. The picker fills it from the host's list-models action.
  assert.ok(clientSrc.includes('writeJson(POLISH_MODEL_KEY, { provider: first.provider, model: first.model })'),
    'the first available route must be picked by default');
  assert.ok(clientSrc.includes('writeJson(POLISH_MODEL_KEY, { provider: picked.provider, model: picked.model })'),
    'the picker must persist the user choice');
  assert.ok(clientSrc.includes('t("polish.modelTitle")'));
  assert.ok(clientSrc.includes('void listModels().then((routes) => {'));
});

test('client: MediaRecorder is started with a timeslice so previews see chunks', () => {
  // Without a timeslice ondataavailable only fires at stop(), so every 3 s
  // preview built an empty blob and the "realtime preview" never existed.
  assert.ok(clientSrc.includes('recorder.start(1000)'), 'a timeslice is required for live chunks');
  assert.ok(clientSrc.includes('let previewChunkIndex = 0;'));
  assert.ok(clientSrc.includes('const tail = recordingChunks.slice(previewChunkIndex);'),
    'previews must upload only the new audio, not the whole recording');
});
test('client: a local preview never marks in-flight audio as transcribed', () => {
  // ondataavailable keeps firing while the preview request is in flight.
  // Advancing previewChunkIndex to recordingChunks.length AFTER the await
  // therefore declared that never-uploaded audio as already transcribed, and
  // the realtime preview silently skipped 1-3 s of speech on every cycle.
  assert.ok(clientSrc.includes('const sentThrough = previewChunkIndex + tail.length;'),
    'the reach of the uploaded blob must be snapshotted before the await');
  assert.ok(clientSrc.includes('previewChunkIndex = sentThrough;'),
    'the chunk cursor must advance only over what was actually uploaded');
  assert.ok(!/previewChunkIndex = recordingChunks\.length;/.test(clientSrc),
    'the cursor must never jump to the live chunk count');
});

test('client: a blur while getUserMedia is pending cancels the recording', () => {
  // Alt+Tab during the permission prompt started a recording in the
  // background: the mic stayed hot and nothing stopped it.
  assert.ok(clientSrc.includes('let cancelPendingStart = false;'));
  assert.ok(/if \(startPending\) \{[\s\S]{0,120}cancelPendingStart = true;/.test(clientSrc));
  assert.ok(/if \(cancelPendingStart\) \{[\s\S]{0,260}track.stop\(\)/.test(clientSrc));
});

test('client: the decode AudioContext is closed on every path', () => {
  // ctx.close() ran only on success: repeated failed decodes exhausted the
  // browser's context budget and broke the local engine + level meter.
  assert.ok(/let ctx = null;/.test(clientSrc));
  assert.ok(/finally \{[\s\S]{0,300}if \(ctx\) ctx.close\(\)/.test(clientSrc));
});

test('client: a Web Speech error rolls the interim hypothesis back', () => {
  assert.ok(/if \(wsError !== null\) \{[\s\S]{0,400}rollbackPreview\(wsDraftBase\)/.test(clientSrc));
});

test('client: the cloud call timeout scales with the provider chain', () => {
  // The host tries providers sequentially at up to 60 s each: a fixed 75 s
  // client cap aborted a chain the user configured on purpose.
  assert.ok(clientSrc.includes('const ASR_PROVIDER_TIMEOUT_MS = 60_000;'));
  assert.ok(clientSrc.includes('HOST_CALL_TIMEOUT_MS + ASR_PROVIDER_TIMEOUT_MS * (hostProviderCount - 1)'));
  assert.ok(clientSrc.includes('void fetchSettings().then(applyHostSettings)'));
});

test('client: the mic button polls the real busy state', () => {
    assert.ok(clientSrc.includes('window.__voiceScribeBusy = busy'));
    assert.ok(/busy: busy === true/.test(clientSrc));
  });
test('client: the settings nav label follows the UI locale', () => {
  // A fixed bilingual string cannot follow the UI language. The shell owns a
  // `SlotLabel = string | (() => string)` and resolves it through
  // resolveSlotLabel on every read (and re-reads on each locale bump).
  assert.ok(/label: \(\) => ctx\.locale\.bind\(SETTINGS_NS\)\("section\.title"\)/.test(clientSrc),
    'the section label must be a locale-resolving thunk');
  assert.ok(clientSrc.includes('"section.title": "语音输入"'), 'zh label text');
  assert.ok(clientSrc.includes('"section.title": "Voice Input"'), 'en label text');
  assert.ok(!clientSrc.includes('label: "语音输入 / Voice Input"'),
    'the hard-coded bilingual label must be gone');
});
}

// ---------- client bundle: real composer-adapter behaviour (vm + DOM stub) ----------
/**
 * Load lib/client.js in a vm sandbox with a minimal DOM stub and return the
 * plugin's exported client face. The bundle is browser-only code, but its
 * composer adapters are pure DOM logic — exactly what broke when DSH 0.1.2
 * replaced the composer textarea with a Lexical contenteditable.
 */
function loadClientFace(dom, storage) {
  const vm = require('node:vm');
  const registrations = [];
  dom.window.__ModuleLoader__ = { load: (registration) => registrations.push(registration) };
  const sandbox = {
    window: dom.window,
    document: dom.document,
    navigator: { language: 'zh-CN' },
    // A Map turns the stub into real storage so tests can exercise settings
    // that are read from localStorage (e.g. the pinned capture device).
    localStorage: storage instanceof Map
      ? {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => { storage.set(key, String(value)); },
        removeItem: (key) => { storage.delete(key); }
      }
      : { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Event: class StubEvent { constructor(type, init) { this.type = type; this.bubbles = !!(init && init.bubbles); } },
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
    URL
  };
  // The bundle reads window.localStorage (not the bare global), so the stub has
  // to live on the DOM window as well — otherwise every setting silently falls
  // back to its default in the sandbox.
  dom.window.localStorage = sandbox.localStorage;
  sandbox.globalThis = sandbox;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8'), vm.createContext(sandbox), {
    filename: 'lib/client.js'
  });
  assert.strictEqual(registrations.length, 1, 'the bundle must register exactly once via __ModuleLoader__');
  return registrations[0].factory(() => ({}));
}

/** DSH 0.1.2+ composer: a Lexical contenteditable inside [data-composer-card]. */
function modernComposerDom() {
  const calls = [];
  let cardRef = null;
  const editor = {
    tagName: 'DIV',
    innerText: '已有草稿',
    textContent: '已有草稿',
    contains: (el) => el === editor,
    closest: () => cardRef,
    focus() { this.focused = true; },
    dispatchEvent(event) { this.lastEvent = event; }
  };
  const card = {
    tagName: 'DIV',
    querySelector: (sel) => (sel === 'textarea' ? null : sel === '[contenteditable="true"]' ? editor : null),
    contains: (el) => el === editor,
    closest: () => null
  };
  cardRef = card;
  const document = {
    querySelector: (sel) => (String(sel).startsWith('[data-composer-card') ? card : null),
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    execCommand: (cmd, _ui, text) => { calls.push([cmd, text]); return true; },
    body: { appendChild() {}, contains: () => true }
  };
  const window = {
    getSelection: () => ({
      rangeCount: 1,
      removeAllRanges() {},
      addRange() {},
      getRangeAt: () => ({ startContainer: editor })
    }),
    addEventListener() {},
    removeEventListener() {}
  };
  return { card, editor, calls, document, window };
}

/** Legacy composer (DSH <= 0.1.1): a plain textarea inside the same card. */
function legacyComposerDom() {
  const textarea = {
    tagName: 'TEXTAREA',
    value: '旧草稿',
    selectionStart: 3,
    selectionEnd: 3,
    setRangeText(text) { this.value = text; },
    dispatchEvent(event) { this.lastEvent = event; },
    focus() {},
    contains: () => false
  };
  const card = {
    tagName: 'DIV',
    querySelector: (sel) => (sel === 'textarea' ? textarea : null),
    contains: (el) => el === textarea
  };
  const document = {
    querySelector: (sel) => (String(sel).startsWith('[data-composer-card') ? card : null),
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    execCommand: () => false,
    body: { appendChild() {}, contains: () => true }
  };
  const window = { getSelection: () => null, addEventListener() {}, removeEventListener() {} };
  return { card, editor: textarea, textarea, document, window };
}

test('client(behaviour): a preview never overwrites what the user typed mid-dictation', () => {
  const dom = modernComposerDom();
  const face = loadClientFace(dom);
  const writes = [];
  let draft = '基线';
  face.setDraftChannel({ getDraft: () => draft, setDraft: (text) => { draft = text; writes.push(text); } });
  face.resetPreviewState();
  face.writePreviewSpan('基线 说');
  face.writePreviewSpan('基线 说话');
  // The user starts typing while still dictating.
  draft = '用户打的新内容';
  assert.strictEqual(face.writePreviewSpan('基线 说话中'), false,
    'a preview must be refused once the composer holds the user text');
  assert.deepStrictEqual(writes, ['基线 说', '基线 说话'],
    'the interim must never replace what the user typed');
  assert.strictEqual(draft, '用户打的新内容');
  // The final transcript is appended to their text, never rebased over it.
  assert.strictEqual(face.commitTranscript('基线', '最终文本'), true);
  assert.strictEqual(draft, '用户打的新内容 最终文本');
});

test('client(behaviour): speech segments are not glued together', () => {
  const dom = modernComposerDom();
  const face = loadClientFace(dom);
  // Chrome/Edge usually include the separating space, but not always — and
  // two glued English finals produce "helloworld".
  assert.strictEqual(face.appendSpeechSegment('hello', 'world'), 'hello world');
  assert.strictEqual(face.appendSpeechSegment('hello ', 'world'), 'hello world');
  assert.strictEqual(face.appendSpeechSegment('hello', ' world'), 'hello world');
  // CJK must never gain an inserted space.
  assert.strictEqual(face.appendSpeechSegment('你好', '世界'), '你好世界');
  assert.strictEqual(face.appendSpeechSegment('', 'hi'), 'hi');
  assert.strictEqual(face.appendSpeechSegment('hi', ''), 'hi');
});

test('client(behaviour): finds the contenteditable composer editor of DSH 0.1.2+', () => {
  const dom = modernComposerDom();
  const face = loadClientFace(dom);
  assert.strictEqual(face.findComposerEditor(), dom.editor,
    'a composer card without a textarea must resolve to its contenteditable');
  assert.strictEqual(face.readEditorText(dom.editor), '已有草稿');
});

test('client(behaviour): writes the draft through the editor input pipeline', () => {
  const dom = modernComposerDom();
  const face = loadClientFace(dom);
  assert.strictEqual(face.setDraftText('新草稿'), true);
  assert.deepStrictEqual(dom.calls, [['insertText', '新草稿']],
    'a contenteditable must be written through execCommand so Lexical stays in sync');
  assert.strictEqual(face.isComposerEditable({ closest: () => dom.card }), true,
    'focus anywhere inside the composer card is the composer');
});

test('client(behaviour): the draft channel wins over the DOM fallback', () => {
  const dom = modernComposerDom();
  const face = loadClientFace(dom);
  const written = [];
  face.setDraftChannel({ getDraft: () => '来自插槽', setDraft: (text) => written.push(text) });
  assert.strictEqual(face.draftText(), '来自插槽');
  assert.strictEqual(face.setDraftText('最终稿'), true);
  assert.deepStrictEqual(written, ['最终稿']);
  assert.deepStrictEqual(dom.calls, [], 'the DOM path must not run while a channel is live');
  face.setDraftChannel(null);
  assert.strictEqual(face.draftText(), '已有草稿', 'releasing the channel falls back to the DOM');
});

test('client(behaviour): legacy textarea composers still work', () => {
  const dom = legacyComposerDom();
  const face = loadClientFace(dom);
  assert.strictEqual(face.findComposerEditor(), dom.textarea);
  assert.strictEqual(face.readEditorText(dom.textarea), '旧草稿');
  assert.strictEqual(face.setDraftText('替换稿'), true);
  assert.strictEqual(dom.textarea.value, '替换稿');
});

test('client(behaviour): a plain Alt keypress in the composer is not swallowed', () => {
  const dom = modernComposerDom();
  const face = loadClientFace(dom);
  // The keydown guard skips editable elements that are NOT the composer; the
  // contenteditable composer must classify as the composer or every Alt press
  // while typing is ignored.
  assert.strictEqual(face.isComposerEditable(dom.editor), true);
  assert.strictEqual(face.isComposerEditable({ closest: () => null }), false);
});

test('client(behaviour): the final transcript rebuilds the preview span, never the user draft', () => {
  const dom = modernComposerDom();
  const face = loadClientFace(dom);
  const writes = [];
  let draft = '已有草稿';
  face.setDraftChannel({ getDraft: () => draft, setDraft: (text) => { draft = text; writes.push(text); } });
  face.resetPreviewState();
  face.writePreviewSpan('已有草稿 边说边出');
  // The composer still holds exactly our preview span → rebuild from baseline.
  assert.strictEqual(face.commitTranscript('已有草稿', '最终文本'), true);
  assert.deepStrictEqual(writes, ['已有草稿 边说边出', '已有草稿 最终文本']);
});

test('client(behaviour): a draft edited while dictating is appended to, not clobbered', () => {
  const dom = modernComposerDom();
  const face = loadClientFace(dom);
  const writes = [];
  let draft = '已有草稿';
  face.setDraftChannel({ getDraft: () => draft, setDraft: (text) => { draft = text; writes.push(text); } });
  face.resetPreviewState();
  face.writePreviewSpan('已有草稿 边说边出');
  // The user sent the draft (Enter clears the composer) or typed something new.
  draft = '用户新输入的内容';
  assert.strictEqual(face.commitTranscript('已有草稿', '最终文本'), true);
  assert.deepStrictEqual(writes, ['已有草稿 边说边出', '用户新输入的内容 最终文本'],
    'the already-sent text must not be resurrected and the new draft must survive');
});

test('client(behaviour): rollback only rewrites a composer still holding the preview', () => {
  const dom = modernComposerDom();
  const face = loadClientFace(dom);
  const writes = [];
  let draft = '基线';
  face.setDraftChannel({ getDraft: () => draft, setDraft: (text) => { draft = text; writes.push(text); } });
  face.resetPreviewState();
  face.writePreviewSpan('基线 预览');
  face.rollbackPreview('基线');
  assert.deepStrictEqual(writes, ['基线 预览', '基线'], 'an untouched preview is rolled back');
  face.writePreviewSpan('基线 预览');
  draft = '用户改了';
  face.rollbackPreview('基线');
  assert.deepStrictEqual(writes, ['基线 预览', '基线', '基线 预览'], 'an edited draft must be left alone');
  assert.strictEqual(draft, '用户改了');
});

test('client(behaviour): the pinned microphone becomes an exact getUserMedia constraint', () => {
  // A device-less getUserMedia({audio:true}) is resolved by the BROWSER, not by
  // the OS: that is how a silent virtual microphone (Steam Streaming
  // Microphone, a dead Bluetooth HFP endpoint) ends up recording while the pill
  // says 录音中 and nothing is transcribed.
  const store = new Map();
  const face = loadClientFace(modernComposerDom(), store);
  // Field-wise assertions: the bundle runs in a vm realm, so its objects have a
  // different Object.prototype and deepStrictEqual would reject them.
  assert.strictEqual(face.audioConstraints().audio, true,
    'with nothing pinned the request stays device-less');
  store.set('dsh-voice-input:device', JSON.stringify('mic-usb-camera'));
  const pinned = face.audioConstraints();
  assert.strictEqual(typeof pinned.audio, 'object', 'a pinned device changes the constraint shape');
  assert.strictEqual(pinned.audio.deviceId.exact, 'mic-usb-camera',
    'a pinned device is requested exactly — a soft preference would degrade back to the default');
});

test('client(behaviour): the silence hint only fires for a silent take', () => {
  const face = loadClientFace(modernComposerDom());
  assert.strictEqual(face.silenceHint(null), '', 'an unknown level must never be reported as silence');
  assert.strictEqual(face.silenceHint(undefined), '');
  assert.match(face.silenceHint(0), /输入电平≈0/, 'a dead-flat take is the silent-device signature');
  assert.match(face.silenceHint(0.004), /输入电平≈0/);
  assert.strictEqual(face.silenceHint(0.02), '', 'faint but real audio keeps the plain hint');
});

test('client(behaviour): a long device label is truncated for the status pill', () => {
  const face = loadClientFace(modernComposerDom());
  assert.strictEqual(face.shortDeviceLabel('  麦克风 (USB 2.0 Camera)  '), '麦克风 (USB 2.0 Camera)');
  assert.strictEqual(face.shortDeviceLabel(null), '');
  const long = '默认 - 麦克风 (USB 2.0 Camera) 名称很长';
  const short = face.shortDeviceLabel(long);
  assert.strictEqual(short.length, 22);
  assert.ok(long.startsWith(short.slice(0, -1)), 'truncation keeps the head of the real name');
});

test('client: a vanished pinned device falls back to the default and is forgotten', () => {
  assert.ok(/pinnedDevice && \(errorName === "OverconstrainedError" \|\| errorName === "NotFoundError"\)/.test(clientSrc));
  assert.ok(clientSrc.includes('writeDeviceId("");'), 'the dead id must not be retried on every take');
  assert.ok(clientSrc.includes('deviceNotice'), 'the fall-back has to be visible, never silent');
});

test('client: the device picker never opens the microphone just to list devices', () => {
  assert.ok(clientSrc.includes('const DEVICE_KEY = "dsh-voice-input:device";'));
  assert.ok(clientSrc.includes('"device.title": "麦克风设备"'), 'zh label');
  assert.ok(clientSrc.includes('"device.title": "Microphone device"'), 'en label');
  assert.ok(clientSrc.includes('"device.noteEmpty"'));
  assert.ok(clientSrc.includes('addEventListener("devicechange", sync)'), 'Bluetooth devices come and go');
  const rowStart = clientSrc.indexOf('function VoiceScribeRow');
  const row = clientSrc.slice(rowStart, clientSrc.indexOf('function MicrophoneButton', rowStart));
  assert.ok(row.length > 1000, 'the row source must actually be sliced');
  // Comments are stripped: the row documents WHY it stays away from
  // getUserMedia, and that sentence must not trip the assertion itself.
  const rowCode = row.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!/getUserMedia/.test(rowCode),
    'the settings row must not light the mic indicator just to enumerate devices');
});

test('client: the level meter also tracks an absolute peak for the silence hint', () => {
  assert.ok(clientSrc.includes('getFloatTimeDomainData'));
  assert.ok(clientSrc.includes('recordingPeak = 0;'), 'a live analyser means a known level');
  assert.ok(/recordingPeak = null;/.test(clientSrc), 'every start resets it to "unknown"');
  assert.ok(clientSrc.includes('silenceHint(recordingPeak)'));
  assert.ok(/recognition\.start\(\);[\s\S]{0,260}recordingPeak = null;/.test(clientSrc),
    'Web Speech never runs the meter — its start must reset the peak to "unknown" too');
});

const { pathToFileURL } = require('node:url');

async function main() {
  await behavioural();
  if (wroteLlmStub) {
    fs.rmSync(path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-llm'), { recursive: true, force: true });
  }
  console.log('');
  console.log('TOTAL: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('TEST RUNNER ERROR:', e);
  process.exit(1);
});
