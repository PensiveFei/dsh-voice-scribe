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

// ---------- repo-level consistency ----------
test('repo: cordis.patch.yml name matches plugin name', () => {
  const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.includes("name: 'dsh-voice-scribe'"));
  assert.ok(patch.includes('id: voice-scribe'));
  assert.ok(!patch.includes('dsh-voice-input'), 'patch must not reference the old package name');
});

test('repo: package.json files entries all exist', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.version === '0.2.0', 'version should be 0.2.0, got ' + pkg.version);
  for (const f of pkg.files) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), 'files entry missing: ' + f);
  }
});

// ---------- docs: disclaimer present ----------
const readme = fs.existsSync(path.join(ROOT, 'README.md'))
  ? fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  : '';
test('docs: README has disclaimer', () => {
  assert.ok(readme.includes('免责声明') || readme.includes('disclaimer'), 'README should carry a disclaimer');
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
