// SPDX-License-Identifier: MIT
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');

let utils, host, scratch, previousHome, wroteStub = false;
const stubDir = path.join(__dirname, '..', 'node_modules', '@deepseek-ai', 'dsh-llm');

before(async () => {
  utils = await import('../lib/host-utils.js');
  host = await import('../lib/index.js');
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-host-regression-'));
  previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = scratch;
  if (!fs.existsSync(path.join(stubDir, 'package.json'))) {
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', type: 'module', exports: './index.js' }));
    fs.writeFileSync(path.join(stubDir, 'index.js'), 'export function createUserMessage(value) { return value; }\n');
    wroteStub = true;
  }
});

after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  fs.rmSync(scratch, { recursive: true, force: true });
  if (wroteStub) {
    fs.unlinkSync(path.join(stubDir, 'index.js'));
    fs.unlinkSync(path.join(stubDir, 'package.json'));
    fs.rmdirSync(stubDir);
  }
});

function within(promise, ms = 750) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('operation did not settle after cancellation')), ms);
  })]).finally(() => clearTimeout(timer));
}

async function post(payload, extraHeaders = {}) {
  const req = Object.assign(new PassThrough(), { method: 'POST', headers: { 'content-type': 'application/json', ...extraHeaders } });
  const res = Object.assign(new EventEmitter(), {
    status: 0, headers: {}, writableEnded: false,
    setHeader(key, value) { this.headers[key] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(body) { this.body = JSON.parse(body); this.writableEnded = true; }
  });
  const done = host.handleApi(req, res, {});
  req.end(JSON.stringify(payload));
  await done;
  return res;
}

const cloudOptions = (settings = { asrApiKey: 'test-credential-987654' }) => ({
  audioBase64: 'YQ==', mimeType: 'audio/webm', language: '', settings
});

test('JSON body settles when an upload aborts before end', async () => {
  const req = new PassThrough();
  const done = utils.readJsonBody(req);
  req.write('{"incomplete":');
  req.emit('aborted');
  assert.equal(await within(done), null);
  req.destroy();
});

test('JSON body settles when a request closes without end or error', async () => {
  const req = new PassThrough();
  const done = utils.readJsonBody(req);
  req.emit('close');
  assert.equal(await within(done), null);
  req.destroy();
});

test('trust fence rejects userinfo and path components in Host', () => {
  for (const authority of ['untrusted.example@localhost:9999', 'localhost/path', 'localhost?query', 'localhost#fragment', 'localhost\\path']) {
    assert.equal(utils.isTrustedApiRequest({ headers: { host: authority } }, []), false, authority);
  }
  assert.equal(utils.isTrustedApiRequest({ headers: { host: 'LOCALHOST:9999' } }, []), true);
});

test('API rejects media types that merely begin with application/json', async () => {
  for (const contentType of ['application/jsonp', 'application/json-anything']) {
    assert.equal((await post({ action: 'get-settings' }, { 'content-type': contentType })).status, 415);
  }
  assert.equal((await post({ action: 'get-settings' }, { 'content-type': 'application/json; charset=utf-8' })).status, 200);
});

test('settings reject malformed URLs and embedded credentials before persisting', async () => {
  utils.writeSettings({ language: 'zh' });
  for (const url of ['https://', 'https://user:secret@example.test/asr', 'https://example.test/#secret', 'https://example.test/has space']) {
    assert.equal((await post({ action: 'set-settings', patch: { asrUrl: url } })).status, 400, url);
    assert.equal((await post({ action: 'set-settings', patch: { asrProviders: [{ url }] } })).status, 400, url);
    assert.deepEqual(utils.readSettings(), { language: 'zh' });
  }
});

test('settings key migration is independent of patch property order', async () => {
  const credential = 'legacy-credential-54321';
  utils.writeSettings({ asrApiKey: credential });
  const res = await post({ action: 'set-settings', patch: {
    asrApiKey: null, asrUrl: null, asrModel: null,
    asrProviders: [{ url: utils.DEFAULT_ASR_URL, model: 'whisper-large-v3' }]
  } });
  assert.equal(res.status, 200);
  assert.equal(utils.readSettings().asrProviders[0].key, credential);
  assert.equal(utils.readSettings().asrApiKey, undefined);
});

test('changing a legacy endpoint cannot inherit another endpoint credential', async () => {
  utils.writeSettings({ asrUrl: 'https://first.example/asr', asrApiKey: 'original-credential' });
  assert.equal((await post({ action: 'set-settings', patch: { asrUrl: 'https://second.example/asr' } })).status, 200);
  assert.equal(utils.readSettings().asrApiKey, undefined);
  assert.equal((await post({ action: 'set-settings', patch: { asrUrl: 'https://third.example/asr', asrApiKey: 'replacement-credential' } })).status, 200);
  assert.equal(utils.readSettings().asrApiKey, 'replacement-credential');
});

test('atomic settings failures preserve the previous file', () => {
  utils.writeSettings({ language: 'zh' });
  const circular = {}; circular.self = circular;
  assert.throws(() => utils.writeSettings(circular));
  assert.deepEqual(utils.readSettings(), { language: 'zh' });
  assert.deepEqual(fs.readdirSync(scratch).filter((name) => name.endsWith('.tmp')), []);
});

test('rewriting settings repairs permissive POSIX file permissions', { skip: process.platform === 'win32' }, () => {
  utils.writeSettings({ language: 'zh' });
  fs.chmodSync(utils.settingsPath(), 0o644);
  utils.writeSettings({ language: 'en' });
  assert.equal(fs.statSync(utils.settingsPath()).mode & 0o777, 0o600);
});

test('cloud errors redact every configured key before returning it to callers', async (t) => {
  const credential = 'credential-with/slash+and?query';
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Rejected ' + credential + ' or ' + encodeURIComponent(credential) } }) }));
  await assert.rejects(utils.transcribeAudio(cloudOptions({ asrApiKey: credential })), (error) => {
    assert.equal(error.code, 'asr-http');
    assert.ok(error.message.includes('[redacted]'));
    assert.ok(!error.message.includes(credential));
    assert.ok(!error.message.includes(encodeURIComponent(credential)));
    return true;
  });
});

test('network error text cannot leak the configured ASR key', async (t) => {
  const credential = 'network-credential-123456';
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('request failed with ' + credential); });
  await assert.rejects(utils.transcribeAudio(cloudOptions({ asrApiKey: credential })), (error) => !error.message.includes(credential));
});

test('provider error redaction runs before truncation of a long credential', async (t) => {
  const credential = 'long-credential-' + 'z'.repeat(700);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401, json: async () => ({ error: { message: credential } }) }));
  await assert.rejects(utils.transcribeAudio(cloudOptions({ asrApiKey: credential })), (error) => !error.message.includes(credential.slice(0, 100)));
});

test('streamed cloud responses are bounded and cancelled on overflow', async (t) => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(utils.MAX_ASR_RESPONSE_BYTES + 1)); },
    cancel() { cancelled = true; }
  }));
  t.mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(utils.transcribeAudio(cloudOptions()), (error) => error.code === 'asr-response-too-large');
  assert.equal(cancelled, true);
});

test('cloud cancellation settles even when fetch ignores AbortSignal', async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', () => new Promise(() => {}));
  const done = utils.transcribeAudio({ ...cloudOptions(), signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(within(done), (error) => error.code === 'asr-aborted');
});

test('cloud cancellation also settles while a response body ignores AbortSignal', async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: () => new Promise(() => {}) }));
  const done = utils.transcribeAudio({ ...cloudOptions(), signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(within(done), (error) => error.code === 'asr-aborted');
});

test('cloud requests disable redirects and preserve codec-qualified audio extensions', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.body.get('file').name, 'recording.ogg');
    return { ok: true, json: async () => ({ text: 'ok' }) };
  });
  assert.equal(await utils.transcribeAudio({ ...cloudOptions(), mimeType: 'audio/ogg; codecs=opus' }), 'ok');
});

test('cloud rejects malformed and noncanonical base64 without a provider call', async (t) => {
  let called = false;
  t.mock.method(globalThis, 'fetch', async () => { called = true; });
  for (const audioBase64 of ['Y!Q==', 'YQ', 'YQ==\n', 'YR==', '=YQ=', null]) {
    await assert.rejects(utils.transcribeAudio({ ...cloudOptions(), audioBase64 }), (error) => error.code === 'invalid-audio');
  }
  assert.equal(called, false);
});

test('local API rejects invalid sample rates before calling the native recognizer', async () => {
  for (const sampleRate of [null, '16000', 0, 16000.5, 7999, 192001]) {
    const res = await post({ action: 'local-transcribe', audio: 'AAAAAA==', sampleRate });
    assert.equal(res.status, 400);
  }
});

test('already-aborted polish preserves raw text without invoking the LLM', async () => {
  const controller = new AbortController(); controller.abort();
  let called = false;
  const ctx = { llm: { prepareCall() { called = true; throw new Error('must not run'); } } };
  assert.equal(await host.polishText({ text: 'original', provider: 'p', model: 'm', ctx, signal: controller.signal }), 'original');
  assert.equal(called, false);
});

test('polish cancellation settles while prepareCall ignores AbortSignal', async () => {
  const controller = new AbortController();
  const ctx = { llm: { prepareCall: () => new Promise(() => {}) } };
  const done = host.polishText({ text: 'original', provider: 'p', model: 'm', ctx, signal: controller.signal });
  setImmediate(() => controller.abort());
  assert.equal(await within(done), 'original');
});

test('polish cancellation settles while a model stream ignores AbortSignal', async () => {
  const controller = new AbortController();
  let startStream;
  const started = new Promise((resolve) => { startStream = resolve; });
  const ctx = { llm: { prepareCall: async () => ({ config: {}, stream: async function* () {
    startStream();
    await new Promise(() => {});
  } }) } };
  const done = host.polishText({ text: 'original', provider: 'p', model: 'm', ctx, signal: controller.signal });
  await within(started);
  controller.abort();
  assert.equal(await within(done), 'original');
});

test('excessive polish output aborts the model and preserves the transcript', async () => {
  let streamSignal;
  const ctx = { llm: { prepareCall: async () => ({ config: {}, stream: async function* ({ signal }) {
    streamSignal = signal;
    yield { type: 'text-delta', text: 'x'.repeat(12001) };
  } }) } };
  assert.equal(await host.polishText({ text: 'original', provider: 'p', model: 'm', ctx }), 'original');
  assert.equal(streamSignal.aborted, true);
});

test('bounded hotword workers preserve existing regex captures and literal dollar signs', async () => {
  const { rules } = utils.parseHotwords('老师=老诗\n/老\\s*师/教师/\n/\\{([^}]+)\\}/[$1]/g\n$&=美元');
  assert.equal(await utils.applyHotwordsBounded('老诗 老 师 {内容} 美元', rules), '教师 教师 [内容] $&');
});

test('pathological hotword regex times out without stalling the host or losing speech', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (code) => warnings.push(code));
  const original = 'a'.repeat(42) + '!';
  const { rules } = utils.parseHotwords('/(a+)+$/replacement/g');
  let hostResponsive = false;
  const done = utils.applyHotwordsBounded(original, rules);
  const timer = setTimeout(() => { hostResponsive = true; }, 25);
  assert.equal(await within(done, utils.HOTWORD_TIMEOUT_MS + 3000), original);
  clearTimeout(timer);
  assert.equal(hostResponsive, true, 'the host event loop must continue serving other work');
  assert.deepEqual(warnings, ['[dsh-voice-scribe] hotword-timeout']);
});

test('hotword cancellation terminates a stuck rule and preserves original speech', async () => {
  const controller = new AbortController();
  const original = 'a'.repeat(42) + '!';
  const { rules } = utils.parseHotwords('/(a+)+$/replacement/g');
  const done = utils.applyHotwordsBounded(original, rules, controller.signal);
  setTimeout(() => controller.abort(), 25);
  assert.equal(await within(done), original);
});

test('literal hotword expansion also obeys the worker output limit', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const original = 'a'.repeat(2048);
  const rules = [{ kind: 'literal', wrongs: ['a'], right: 'b'.repeat(1024) }];
  assert.equal(await within(utils.applyHotwordsBounded(original, rules)), original);
});

test('hotword worker concurrency is bounded and excess requests retain their text', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const controller = new AbortController();
  const original = 'a'.repeat(42) + '!';
  const { rules } = utils.parseHotwords('/(a+)+$/replacement/g');
  const pending = Array.from({ length: 4 }, () => utils.applyHotwordsBounded(original, rules, controller.signal));
  assert.equal(await within(utils.applyHotwordsBounded('fifth request', rules)), 'fifth request');
  controller.abort();
  assert.deepEqual(await within(Promise.all(pending)), Array(4).fill(original));
});

test('the catch-all API logger never serializes upstream exception content', async (t) => {
  const secret = 'not-a-real-provider-credential';
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  let handler;
  host.apply({
    webStartup: { trustedHosts: [] },
    webServer: { register(def) { handler = def.handler; return () => {}; } },
    effect(callback) { callback(); },
    llm: { listProviders() { throw new Error(secret); } }
  });
  const req = Object.assign(new PassThrough(), {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }
  });
  const res = Object.assign(new EventEmitter(), {
    setHeader() {}, writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); this.writableEnded = true; }
  });
  const done = handler(req, res);
  req.end('{"action":"list-models"}');
  await done;
  assert.equal(res.status, 500);
  assert.equal(res.body.error.message, 'internal error');
  assert.ok(logs.length > 0);
  assert.ok(!JSON.stringify(logs).includes(secret));
});
