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

const src = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8');
const clientSrc = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');
const utilsSrc = fs.readFileSync(path.join(ROOT, 'lib', 'host-utils.js'), 'utf8');

// ---------- server-side: source shape (needs DSH host to mount) ----------
test('host: exports name and inject', () => {
  assert.ok(/export const name = "dsh-voice-scribe"/.test(src));
  assert.ok(/export const inject = \["webServer", "webRuntime", "llm"\]/.test(src));
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

// ---------- client-side: source shape (needs browser DOM) ----------
test('client: loads via ModuleLoader with the registered id', () => {
  assert.ok(clientSrc.includes('window.__ModuleLoader__.load'));
  assert.ok(clientSrc.includes('id: "dsh-voice-scribe"'));
});

test('client: supports alt and alt-space hotkeys', () => {
  assert.ok(clientSrc.includes('HOTKEYS = ["alt", "alt-space"]'));
  assert.ok(clientSrc.includes('event.key === "Alt"'));
  assert.ok(clientSrc.includes('event.key === " " && event.altKey'));
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
  assert.ok(clientSrc.includes('function TextRow'));
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

test('client: draft channel prefers slot setDraft, falls back to textarea', () => {
  assert.ok(clientSrc.includes('function setDraftChannel'));
  assert.ok(clientSrc.includes('function draftText()'));
  assert.ok(clientSrc.includes('function setDraftText(text)'));
  assert.ok(clientSrc.includes('function insertTranscript(text)'));
  assert.ok(clientSrc.includes('draftChannel && typeof draftChannel.setDraft === "function"'));
});

test('client: web speech streams interim results into the composer in realtime', () => {
  assert.ok(clientSrc.includes('wsDraftBase'));
  assert.ok(clientSrc.includes('setDraftText(wsDraftBase + sep + wsLastInterim)'));
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
  assert.ok(/recording = true;[\s\S]{0,420}if \(holdStopPending\)/.test(clientSrc), 'startRecording must consume holdStopPending');
  assert.ok(/wsRecording = true;[\s\S]{0,220}if \(holdStopPending\)/.test(clientSrc), 'startWebSpeech must consume holdStopPending');
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
  assert.ok(pkg.version === '0.4.2', 'version should be 0.4.2, got ' + pkg.version);
  for (const f of pkg.files) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), 'files entry missing: ' + f);
  }
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

// ---------- REAL behavioural tests for lib/host-utils.js ----------
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
    fs.writeFileSync(path.join(dir, 'model.int8.onnx'), Buffer.alloc(16));
    fs.writeFileSync(path.join(dir, 'tokens.txt'), 'a b c');
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
    fs.writeFileSync(path.join(dir, 'model.int8.onnx'), Buffer.alloc(16));
    fs.writeFileSync(path.join(dir, 'tokens.txt'), 'a b c');
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
    const http = require('node:http');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-dl-'));
    const payload = Buffer.alloc(256 * 1024, 7); // chunked to exercise the stream loop
    const bad = http.createServer((req, res) => { res.writeHead(404); res.end('nope'); });
    const good = http.createServer((req, res) => {
      if (req.url.endsWith('/tokens.txt')) { res.writeHead(200, { 'content-length': 5 }); res.end('a b c'); return; }
      if (req.url.endsWith('/model.int8.onnx')) {
        res.writeHead(200, { 'content-length': payload.length });
        const step = 32 * 1024;
        let off = 0;
        const timer = setInterval(() => {
          if (off >= payload.length) { clearInterval(timer); res.end(); return; }
          res.write(payload.subarray(off, off + step));
          off += step;
        }, 5);
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => bad.listen(0, '127.0.0.1', r));
    await new Promise((r) => good.listen(0, '127.0.0.1', r));
    try {
      const mirrors = [
        'http://127.0.0.1:' + bad.address().port,
        'http://127.0.0.1:' + good.address().port
      ];
      const start = await local.startModelDownload(dir, mirrors);
      assert.strictEqual(start.ok, true);
      assert.strictEqual(start.started, true);
      for (let i = 0; i < 200 && local.getDownloadState().running; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const state = local.getDownloadState();
      assert.strictEqual(state.running, false);
      assert.strictEqual(state.error, '');
      assert.strictEqual(await local.modelReady(dir), true);
      assert.strictEqual(fs.statSync(path.join(dir, 'model.int8.onnx')).size, payload.length);
      const junk = fs.readdirSync(dir).filter((f) => f.includes('.part'));
      assert.deepStrictEqual(junk, [], 'no .part/.part.fail junk left: ' + junk.join(','));
    } finally {
      await new Promise((r) => bad.close(r));
      await new Promise((r) => good.close(r));
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

  test('utils: applyHotwords applies rules in file order (later sees earlier output)', () => {
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
}

const { pathToFileURL } = require('node:url');

async function main() {
  await behavioural();
  console.log('');
  console.log('TOTAL: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('TEST RUNNER ERROR:', e);
  process.exit(1);
});
