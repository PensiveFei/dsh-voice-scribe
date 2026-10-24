const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');

let local;
before(async () => {
  local = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'local-asr.js')).href);
});

function temporaryDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vs-local-regression-'));
}

function readyDir() {
  const dir = temporaryDir();
  // Sparse placeholders exercise readiness and fake loaders without allocating
  // hundreds of MB or fetching a native model.
  for (const [name, bytes] of [['model.int8.onnx', local.MIN_MODEL_BYTES], ['tokens.txt', local.MIN_TOKENS_BYTES]]) {
    const fd = fs.openSync(path.join(dir, name), 'w');
    fs.ftruncateSync(fd, bytes);
    fs.closeSync(fd);
  }
  return dir;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function response(chunks, { status = 200, length, onRead = () => {}, onCancel = () => {} } = {}) {
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name === 'content-length' && length !== undefined ? String(length) : null },
    body: { getReader: () => ({
      read: async () => {
        onRead();
        return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true };
      },
      cancel: async () => { onCancel(); }
    }) }
  };
}

async function waitDownload() {
  for (let attempt = 0; attempt < 500 && local.getDownloadState().running; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(local.getDownloadState().running, false, 'background fixture download must finish');
  return local.getDownloadState();
}

async function mockedDownload(fetcher, options, mirrors = ['https://fixture.invalid']) {
  const dir = temporaryDir();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    assert.equal((await local.startModelDownload(dir, mirrors, options)).started, true);
    const state = await waitDownload();
    return { state, entries: fs.readdirSync(dir), contents: Object.fromEntries(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name))])) };
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const tinyFiles = { files: { 'tokens.txt': { minBytes: 1, maxBytes: 8 }, 'model.int8.onnx': { minBytes: 1, maxBytes: 8 } } };

test('default downloads reject a successful HTTP response containing a tiny error page', async () => {
  const { state, entries } = await mockedDownload(async () => response([Buffer.from('oops')], { length: 4 }));
  assert.match(state.error, /download too small/);
  assert.deepEqual(entries, []);
});

test('an oversized Content-Length is cancelled before streaming', async () => {
  let reads = 0;
  let cancelled = 0;
  const { state, entries } = await mockedDownload(async () => response([Buffer.from('ignored')], {
    length: 9, onRead: () => { reads++; }, onCancel: () => { cancelled++; }
  }), tinyFiles);
  assert.match(state.error, /maximum size/);
  assert.equal(reads, 0);
  assert.equal(cancelled, 1);
  assert.deepEqual(entries, []);
});

test('chunked downloads cannot exceed their artifact byte limit', async () => {
  let cancelled = 0;
  const { state, entries } = await mockedDownload(async () => response([Buffer.alloc(6), Buffer.alloc(6)], {
    onCancel: () => { cancelled++; }
  }), tinyFiles);
  assert.match(state.error, /maximum size/);
  assert.equal(cancelled, 1);
  assert.deepEqual(entries, []);
});

test('SHA-256 mismatches fail over, and only verified bytes are published', async () => {
  const good = Buffer.from('good');
  const digest = createHash('sha256').update(good).digest('hex');
  let cancelled = 0;
  const files = { files: {
    'tokens.txt': { minBytes: 4, maxBytes: 4, sha256: digest },
    'model.int8.onnx': { minBytes: 4, maxBytes: 4, sha256: digest }
  } };
  const { state, entries, contents } = await mockedDownload(async (url) => response([
    Buffer.from(String(url).startsWith('https://bad.invalid') ? 'evil' : 'good')
  ], { length: 4, onCancel: () => { cancelled++; } }), files, ['https://bad.invalid', 'https://good.invalid']);
  assert.equal(state.error, '');
  assert.deepEqual(entries.sort(), ['model.int8.onnx', 'tokens.txt']);
  assert.deepEqual(contents['tokens.txt'], good);
  assert.deepEqual(contents['model.int8.onnx'], good);
  assert.equal(cancelled, 2, 'both corrupt mirror responses must be cancelled');
});

test('HTTP error responses and missing bodies become ordinary download failures', async () => {
  let cancelled = 0;
  let reads = 0;
  const { state } = await mockedDownload(async () => response([Buffer.alloc(8)], {
    status: 503, onRead: () => { reads++; }, onCancel: () => { cancelled++; }
  }), tinyFiles);
  assert.match(state.error, /HTTP 503/);
  assert.equal(cancelled, 1);
  assert.equal(reads, 0);
  const missing = await mockedDownload(async () => ({ ok: true, body: null, status: 200 }), tinyFiles);
  assert.match(missing.state.error, /empty download response/);
  assert.deepEqual(missing.entries, []);
});

test('model readiness rejects directories and a large but truncated cached model', async () => {
  const dir = readyDir();
  try {
    fs.truncateSync(path.join(dir, 'model.int8.onnx'), 160 * 1024 * 1024);
    assert.equal(await local.modelReady(dir), false);
    fs.rmSync(path.join(dir, 'tokens.txt'));
    fs.mkdirSync(path.join(dir, 'tokens.txt'));
    assert.equal(await local.modelReady(dir, 1, 1), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent recognizer loads for different homes return the correct model', async () => {
  const firstDir = readyDir();
  const secondDir = readyDir();
  const gate = deferred();
  const loadingStarted = deferred();
  const calls = [];
  local.disposeRecognizer();
  const loader = async (dir) => {
    calls.push(dir);
    if (dir === firstDir) { loadingStarted.resolve(); await gate.promise; }
    return { dir };
  };
  try {
    const first = local.ensureRecognizer(firstDir, loader);
    await loadingStarted.promise;
    const second = local.ensureRecognizer(secondDir, loader);
    gate.resolve();
    assert.equal((await first).dir, firstDir);
    assert.equal((await second).dir, secondDir);
    assert.deepEqual(calls, [firstDir, secondDir]);
    assert.equal((await local.ensureRecognizer(secondDir, loader)).dir, secondDir);
    assert.equal(calls.length, 2);
  } finally {
    local.disposeRecognizer();
    fs.rmSync(firstDir, { recursive: true, force: true });
    fs.rmSync(secondDir, { recursive: true, force: true });
  }
});

test('disposing during a load cannot repopulate the recognizer cache', async () => {
  const dir = readyDir();
  const gate = deferred();
  const started = deferred();
  local.disposeRecognizer();
  try {
    const old = local.ensureRecognizer(dir, async () => { started.resolve(); await gate.promise; return { old: true }; });
    await started.promise;
    local.disposeRecognizer();
    const current = await local.ensureRecognizer(dir, async () => ({ current: true }));
    gate.resolve();
    assert.deepEqual(await old, { old: true });
    assert.strictEqual(await local.ensureRecognizer(dir, async () => { throw new Error('cache was overwritten'); }), current);
  } finally {
    local.disposeRecognizer();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('local decode queue is bounded, skips cancelled work, and recovers', async () => {
  const dir = readyDir();
  const gate = deferred();
  const started = deferred();
  const controller = new AbortController();
  let decodes = 0;
  local.disposeRecognizer();
  try {
    await local.ensureRecognizer(dir, async () => ({
      createStream: () => ({ acceptWaveform() {} }),
      decodeAsync: async () => {
        decodes++;
        if (decodes === 1) { started.resolve(); await gate.promise; }
        return { text: '<|en|>ok' };
      }
    }));
    const first = local.transcribePcm(new Float32Array(16), 16000, dir);
    const second = local.transcribePcm(new Float32Array(16), 16000, dir, controller.signal);
    // Attach rejection handlers before aborting queued work.
    const secondResult = second.catch((error) => error);
    const third = local.transcribePcm(new Float32Array(16), 16000, dir);
    const fourth = local.transcribePcm(new Float32Array(16), 16000, dir);
    await started.promise;
    await assert.rejects(local.transcribePcm(new Float32Array(16), 16000, dir), { code: 'asr-busy' });
    controller.abort();
    gate.resolve();
    assert.equal(await first, 'ok');
    assert.equal((await secondResult).code, 'asr-aborted');
    assert.deepEqual(await Promise.all([third, fourth]), ['ok', 'ok']);
    assert.equal(decodes, 3);
    assert.equal(await local.transcribePcm(new Float32Array(16), 16000, dir), 'ok');
  } finally {
    gate.resolve();
    local.disposeRecognizer();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a cancellation during native decode cannot return a stale transcript', async () => {
  const dir = readyDir();
  const gate = deferred();
  const started = deferred();
  const controller = new AbortController();
  local.disposeRecognizer();
  try {
    await local.ensureRecognizer(dir, async () => ({
      createStream: () => ({ acceptWaveform() {} }),
      decodeAsync: async () => { started.resolve(); await gate.promise; return { text: 'stale' }; }
    }));
    const pending = local.transcribePcm(new Float32Array(16), 16000, dir, controller.signal);
    const rejected = assert.rejects(pending, { code: 'asr-aborted' });
    await started.promise;
    controller.abort();
    gate.resolve();
    await rejected;
  } finally {
    gate.resolve();
    local.disposeRecognizer();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PCM decoder rejects malformed, incomplete, noncanonical and nonfinite audio', async () => {
  for (const value of ['!!!!', 'AAAAAA', 'AA=A', 'AAAA\nAAA=', 'AB==', Buffer.from([1, 2, 3]).toString('base64')]) {
    assert.throws(() => local.base64ToFloat32(value), { code: 'invalid-audio' });
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    const bytes = Buffer.alloc(4);
    bytes.writeFloatLE(value);
    assert.throws(() => local.base64ToFloat32(bytes.toString('base64')), { code: 'invalid-audio' });
  }
  const bytes = Buffer.alloc(8);
  bytes.writeFloatLE(0.5, 0);
  bytes.writeFloatLE(-0.25, 4);
  assert.deepEqual([...local.base64ToFloat32(bytes.toString('base64'))], [0.5, -0.25]);
  assert.equal(local.base64ToFloat32(Buffer.alloc(1024 * 1024).toString('base64')).length, 256 * 1024);
  for (const rate of [NaN, Infinity, -1, 0, 16000.5, 1e9]) {
    await assert.rejects(local.transcribePcm(new Float32Array(4), rate), { code: 'invalid-audio' });
  }
  await assert.rejects(local.transcribePcm(new Float32Array([NaN]), 16000), { code: 'invalid-audio' });
  await assert.rejects(local.transcribePcm(new Float32Array(8000 * 600 + 1), 8000), { code: 'invalid-audio' });
});
