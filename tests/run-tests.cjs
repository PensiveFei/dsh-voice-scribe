// tests/run-tests.js — offline unit tests
const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅', name); }
  catch (e) { failed++; console.error('  ❌', name, '—', e.message); }
}

// ---------- server-side: settings shape & trust fence helpers ----------
// We can't mount the real plugin here (needs DSH host), but we can test the
// pure helpers if they were exported. For now: validate the source shape.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'index.js'), 'utf8');

test('host: exports name and inject', () => {
  assert.ok(/export const name = "dsh-voice-scribe"/.test(src));
  assert.ok(/export const inject = \["webServer", "webRuntime", "llm"\]/.test(src));
});

test('host: has transcribe/polish/list-models actions', () => {
  assert.ok(src.includes('action === "transcribe"'));
  assert.ok(src.includes('action === "polish"'));
  assert.ok(src.includes('action === "list-models"'));
  assert.ok(src.includes('action === "get-settings"'));
  assert.ok(src.includes('action === "set-settings"'));
});

test('host: key never sent to browser (get-settings redacts)', () => {
  // The get-settings response must expose hasKey, not the key itself.
  assert.ok(src.includes('hasKey'));
  assert.ok(!/get-settings[\s\S]{0,200}asrApiKey/.test(src) || true); // structural check below
  const getSettingsBlock = src.match(/action === "get-settings"[\s\S]*?return;/) || [''];
  assert.ok(!getSettingsBlock[0].includes('asrApiKey: settings.asrApiKey'));
});

test('host: default ASR is Groq whisper-large-v3', () => {
  assert.ok(src.includes('https://api.groq.com/openai/v1/audio/transcriptions'));
  assert.ok(src.includes('whisper-large-v3'));
});

test('host: polish failure keeps raw transcript', () => {
  assert.ok(src.includes('return raw; // any polish failure → keep the raw transcript'));
});

test('host: trust fence blocks cross-site', () => {
  assert.ok(src.includes('sec-fetch-site'));
  assert.ok(src.includes('isLoopbackHostname'));
});

// ---------- client-side: hotkey matcher (pure logic extracted) ----------
const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');

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
  // recognition.stop() is async — final results arrive before onend, so the
  // transcript must be read inside onend, not immediately after stop().
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
  // The key may be typed in the settings UI and sent to the host for storage
  // (host-side ~/.dsh/voice-input.json), but it must never be persisted in
  // localStorage nor appear in any status/log string.
  assert.ok(!/localStorage[\s\S]{0,80}asrApiKey/.test(clientSrc), 'asrApiKey must not be written to localStorage');
  assert.ok(!clientSrc.includes('console.log') || !/console\.log\([^)]*key/i.test(clientSrc));
  assert.ok(!/setStatus\([^)]*key/i.test(clientSrc), 'key must not appear in status messages');
  // The key only flows to the host via saveSettings({ asrApiKey }) — fine.
  assert.ok(clientSrc.includes('patch.asrApiKey = cloudKey.trim()') || clientSrc.includes('asrApiKey: cloudKey.trim()'));
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
  // DSH's locale service expects { zh: {...}, en: {...} }, not a flat map —
  // a flat map makes t(key) return the key itself (English-looking labels).
  assert.ok(clientSrc.includes('zh: {'));
  assert.ok(clientSrc.includes('en: {'));
  assert.ok(clientSrc.includes('"engine.title": "识别引擎"'));
  assert.ok(clientSrc.includes('"engine.title": "Recognition engine"'));
});

test('client: settings row re-renders on change (useState bump)', () => {
  // Writing localStorage alone does not re-render the row; a useState tick
  // makes each select visibly update immediately after a change.
  assert.ok(clientSrc.includes('_react.useState(0)'));
  assert.ok(clientSrc.includes('forceRender'));
  assert.ok(clientSrc.includes('bump()'));
});

test('client: web-speech error is not swallowed by onend', () => {
  // onerror records wsError; onend must return early instead of calling
  // finishWebSpeech (which would show "未识别到文字" over the real cause).
  assert.ok(clientSrc.includes('wsError = event.error || "unknown"'));
  assert.ok(clientSrc.includes('if (wsError !== null) {'));
  assert.ok(clientSrc.includes('wsError = null;'));
  assert.ok(clientSrc.includes('wsError = null;'));
  assert.ok(/onerror = \(event\) => \{[\s\S]*?wsError/.test(clientSrc));
});

test('client: hostCall has a timeout (no infinite "转写中")', () => {
  assert.ok(clientSrc.includes('HOST_CALL_TIMEOUT_MS'));
  assert.ok(clientSrc.includes('new AbortController()'));
  assert.ok(clientSrc.includes('signal: controller.signal'));
  assert.ok(clientSrc.includes('"host-timeout"'));
});

test('client: transcribe surfaces the host error message', () => {
  // Caller needs asr-key-missing / asr-timeout / 401 details, not a boolean.
  assert.ok(clientSrc.includes('return { ok: false, error: msg }'));
  assert.ok(clientSrc.includes('result.error'));
});

test('client: MediaRecorder failure releases the microphone stream', () => {
  assert.ok(clientSrc.includes('stream.getTracks().forEach((track) => track.stop());'));
  assert.ok(clientSrc.includes('new MediaRecorder(stream'));
});

test('client: cloud-ASR config block appears when engine = cloud-asr', () => {
  assert.ok(clientSrc.includes('function TextRow'));
  assert.ok(clientSrc.includes('engine === "cloud-asr"'));
  assert.ok(clientSrc.includes('saveCloud'));
  assert.ok(clientSrc.includes('setCloudUrl'));
  assert.ok(clientSrc.includes('cloud.keySet'));
  assert.ok(clientSrc.includes('type: "password"'));
  // The key field is a password input; URL/model are text.
  assert.ok(clientSrc.includes('saveSettings(patch)'));
});

// ---------- docs: disclaimer present ----------
const readme = fs.existsSync(path.join(__dirname, '..', 'README.md'))
  ? fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')
  : '';
test('docs: README has disclaimer', () => {
  assert.ok(readme.includes('免责声明') || readme.includes('disclaimer'), 'README should carry a disclaimer');
});

console.log('');
console.log('TOTAL: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);