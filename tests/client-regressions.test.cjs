// Browser recording regressions: exercise the real bundle without hardware/network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

function browser(options = {}) {
  const timers = new Map();
  let nextTimer = 0;
  const storage = new Map([
    ['dsh-voice-input:engine-migrated-v2', 'true'],
    ['dsh-voice-input:engine', JSON.stringify(options.engine || 'web-speech')],
    ['dsh-voice-input:mode', JSON.stringify(options.mode || 'tap')],
  ]);
  if (options.polish) {
    storage.set('dsh-voice-input:polish', 'true');
    storage.set('dsh-voice-input:polish-model', JSON.stringify({ provider: 'p', model: 'm' }));
  }
  const recognizers = [];
  class Recognition {
    constructor() { recognizers.push(this); this.aborts = 0; this.stops = 0; }
    start() {}
    stop() { this.stops++; if (options.speechStopThrows) throw new Error('inactive'); }
    abort() { this.aborts++; }
    result(...segments) {
      const results = segments.map(([text, isFinal]) => Object.assign([{ transcript: text }], { isFinal }));
      this.onresult?.({ resultIndex: 0, results });
    }
    end() { this.onend?.(); }
  }
  const tracks = [{ label: 'Mock microphone', stops: 0, stop() { this.stops++; } }];
  const stream = { getTracks: () => tracks, getAudioTracks: () => tracks };
  const recorders = [];
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.mimeType = 'audio/webm'; this.state = 'inactive'; this.stops = 0; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      this.stops++;
      if (this.state === 'inactive') throw new Error('inactive');
      this.state = 'inactive';
      if (options.autoStop !== false) queueMicrotask(() => this.onstop?.());
    }
    data(size = 400) { this.ondataavailable?.({ data: new Blob([new Uint8Array(size)]) }); }
    end() { this.onstop?.(); }
  }
  const elements = [];
  const document = {
    activeElement: null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => {
      const el = { style: {}, textContent: '', setAttribute() {}, appendChild() {}, remove() {} };
      elements.push(el);
      return el;
    },
    body: { contains: () => true, appendChild() {} },
  };
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ body, signal: init.signal });
    const data = options.fetch ? await options.fetch(body, init) : { ok: true, text: 'recognized', value: {} };
    return { ok: true, json: async () => data };
  };
  const window = {
    SpeechRecognition: Recognition,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    addEventListener() {},
    removeEventListener() {},
    __ModuleLoader__: { load: (registration) => { window.registration = registration; } },
  };
  const instrumented = source.replace('module.exports = {', `module.exports = {
    __test: {
      startWebSpeech, stopWebSpeech, startRecording, stopRecording, onWindowBlur,
      beginHold, endHold, unmountHotkey, polish,
      state: () => ({ wsRecording, recording, recordingStopping, busy, startPending, holdActive, recordingEngine }),
      setLocalReady: (value) => { localReady = value; },
    },`);
  const context = vm.createContext({
    window, document,
    navigator: { language: 'en-US', mediaDevices: { getUserMedia: options.getUserMedia || (async () => stream) } },
    console, URL, Blob, AbortController, MediaRecorder: Recorder,
    FileReader: class {
      readAsDataURL() {
        this.result = 'data:audio/webm;base64,YXVkaW8=';
        if (options.readerDelay) void options.readerDelay.then(() => this.onload());
        else queueMicrotask(() => this.onload());
      }
    },
    fetch,
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearInterval: (id) => timers.delete(id),
  });
  vm.runInContext(instrumented, context, { filename: 'lib/client.js' });
  const face = window.registration.factory(() => ({}));
  let draft = options.draft ?? 'draft';
  face.setDraftChannel({ getDraft: () => draft, setDraft: (text) => { draft = text; } });
  return {
    face, state: face.__test.state, api: face.__test, storage, recognizers, recorders, tracks, stream, requests,
    get draft() { return draft; }, set draft(text) { draft = text; },
    get status() { return elements.find((el) => el.id === 'dsh-voice-input-status')?.textContent || ''; },
    fire(ms) {
      const entries = [...timers].filter(([, timer]) => timer.ms === ms);
      assert.ok(entries.length, `expected an active ${ms}ms timer`);
      for (const [id, timer] of entries) { timers.delete(id); timer.fn(); }
    },
  };
}

test('Web Speech keeps finalized speech and every unfinished segment on stop', () => {
  const b = browser();
  assert.equal(b.api.startWebSpeech(), true);
  const rec = b.recognizers[0];
  rec.result(['first sentence', true], ['second', false], ['part', false]);
  assert.equal(b.draft, 'draft first sentence second part');
  b.api.stopWebSpeech();
  rec.end();
  assert.equal(b.draft, 'draft first sentence second part');
  assert.equal(b.state().busy, false);
});

test('Web Speech rebuilds changing results without duplicating previous finals', () => {
  const b = browser({ draft: '' });
  b.api.startWebSpeech();
  const rec = b.recognizers[0];
  rec.result(['hello', true], ['wor', false]);
  rec.result(['hello', true], ['world', true]);
  rec.end();
  assert.equal(b.draft, 'hello world');
});

test('typing before the first speech preview preserves the user draft', () => {
  const b = browser();
  b.api.startWebSpeech();
  b.draft = 'typed before result';
  b.recognizers[0].result(['spoken', false]);
  assert.equal(b.draft, 'typed before result');
  b.recognizers[0].end();
  assert.equal(b.draft, 'typed before result spoken');
});

test('a cancelled Web Speech take is rolled back by the missing-onend watchdog', () => {
  const b = browser();
  b.api.startWebSpeech();
  b.recognizers[0].result(['unwanted speech', false]);
  b.api.onWindowBlur();
  b.fire(12_000);
  assert.equal(b.draft, 'draft');
  assert.equal(b.status, '已取消');
  assert.equal(b.recognizers[0].aborts, 1);
  assert.equal(b.state().wsRecording, false);
});

test('an errored Web Speech take never commits its partial text on watchdog expiry', () => {
  const b = browser();
  b.api.startWebSpeech();
  b.recognizers[0].result(['partial', false]);
  b.recognizers[0].onerror({ error: 'not-allowed' });
  b.api.stopWebSpeech();
  b.fire(12_000);
  assert.equal(b.draft, 'draft');
  assert.match(b.status, /权限被拒绝/);
});

test('late events from a timed-out recognizer cannot end or edit the next take', () => {
  const b = browser();
  b.api.startWebSpeech();
  const old = b.recognizers[0];
  old.result(['first', true]);
  b.api.stopWebSpeech();
  b.fire(12_000);
  assert.equal(b.draft, 'draft first');
  b.api.startWebSpeech();
  old.result(['stale', false]);
  old.end();
  assert.equal(b.state().wsRecording, true);
  b.recognizers[1].result(['second', true]);
  b.recognizers[1].end();
  assert.equal(b.draft, 'draft first second');
});

test('a throwing Web Speech stop uses cancellation handling', () => {
  const b = browser({ speechStopThrows: true });
  b.api.startWebSpeech();
  b.recognizers[0].result(['unwanted', false]);
  b.api.onWindowBlur();
  assert.equal(b.draft, 'draft');
  assert.equal(b.status, '已取消');
  assert.equal(b.state().wsRecording, false);
});

test('a settings change stops the active capture and retains its cloud engine', async () => {
  const b = browser({ engine: 'cloud-asr' });
  await b.api.startRecording();
  b.recorders[0].data();
  b.storage.set('dsh-voice-input:engine', '"local"');
  b.face.toggleRecording();
  await flush();
  assert.equal(b.recorders[0].stops, 1);
  assert.equal(b.state().recording, false);
  assert.deepEqual(b.requests.map(({ body }) => body.action), ['transcribe']);
  assert.equal(b.draft, 'draft recognized');
});

test('switching from MediaRecorder to Web Speech still stops the live microphone', async () => {
  const b = browser({ engine: 'cloud-asr' });
  await b.api.startRecording();
  b.storage.set('dsh-voice-input:engine', '"web-speech"');
  b.face.toggleRecording();
  await flush();
  assert.equal(b.recognizers.length, 0);
  assert.equal(b.recorders[0].stops, 1);
  assert.equal(b.tracks[0].stops, 1);
});

test('a second tap while MediaRecorder stop is queued cannot reopen or double-stop capture', async () => {
  const b = browser({ engine: 'cloud-asr', autoStop: false });
  await b.api.startRecording();
  b.recorders[0].data();
  b.face.toggleRecording();
  b.face.toggleRecording();
  assert.equal(b.recorders[0].stops, 1);
  assert.equal(b.state().busy, true);
  b.recorders[0].end();
  await flush();
  assert.equal(b.state().busy, false);
  assert.equal(b.draft, 'draft recognized');
});

test('transcription in flight blocks a new take and preserves the old baseline', async () => {
  const result = deferred();
  const b = browser({ engine: 'cloud-asr', fetch: () => result.promise });
  await b.api.startRecording();
  b.recorders[0].data();
  b.api.stopRecording();
  await flush();
  assert.equal(b.state().busy, true);
  b.face.toggleRecording();
  b.api.beginHold();
  assert.equal(b.recorders.length, 1);
  assert.equal(b.state().holdActive, false);
  result.resolve({ ok: true, text: 'final text' });
  await flush();
  assert.equal(b.draft, 'draft final text');
});

test('blank polish responses preserve the complete transcript', async () => {
  const b = browser({ fetch: async () => ({ ok: true, text: '   ' }) });
  assert.equal(await b.api.polish('raw transcript', 'p', 'm'), 'raw transcript');
});

test('disposing a Web Speech plugin aborts capture and restores its untouched preview', () => {
  const b = browser();
  b.api.startWebSpeech();
  const rec = b.recognizers[0];
  rec.result(['preview', false]);
  const lateEnd = rec.onend;
  b.api.unmountHotkey();
  lateEnd();
  assert.equal(rec.aborts, 1);
  assert.equal(b.draft, 'draft');
  assert.equal(b.state().wsRecording, false);
});

test('disposing MediaRecorder immediately stops its tracks and suppresses the queued onstop', async () => {
  const b = browser({ engine: 'cloud-asr', autoStop: false });
  await b.api.startRecording();
  b.recorders[0].data();
  b.api.unmountHotkey();
  b.recorders[0].end();
  await flush();
  assert.equal(b.tracks[0].stops, 1);
  assert.equal(b.state().recording, false);
  assert.equal(b.requests.length, 0);
  assert.equal(b.draft, 'draft');
});

test('disposing during transcription aborts the host request and ignores a late response', async () => {
  const result = deferred();
  const b = browser({ engine: 'cloud-asr', fetch: () => result.promise });
  await b.api.startRecording();
  b.recorders[0].data();
  b.api.stopRecording();
  await flush();
  b.api.unmountHotkey();
  assert.equal(b.requests[0].signal.aborted, true);
  result.resolve({ ok: true, text: 'late response' });
  await flush();
  assert.equal(b.draft, 'draft');
  assert.equal(b.state().busy, false);
});

test('disposing during polish never inserts the raw fallback into the retired composer', async () => {
  const result = deferred();
  const b = browser({ polish: true, fetch: () => result.promise });
  b.api.startWebSpeech();
  b.recognizers[0].result(['raw text', true]);
  b.recognizers[0].end();
  assert.equal(b.state().busy, true);
  assert.equal(b.api.startWebSpeech(), false);
  b.api.unmountHotkey();
  result.resolve({ ok: true, text: 'polished text' });
  await flush();
  assert.equal(b.draft, 'draft');
  assert.equal(b.requests[0].signal.aborted, true);
});

test('blurring while hold-mode permission is pending releases the gesture and the eventual stream', async () => {
  const permission = deferred();
  const b = browser({ engine: 'cloud-asr', mode: 'hold', getUserMedia: () => permission.promise });
  b.api.beginHold();
  b.api.onWindowBlur();
  assert.equal(b.state().holdActive, false);
  permission.resolve(b.stream);
  await flush();
  assert.equal(b.tracks[0].stops, 1);
  assert.equal(b.recorders.length, 0);
  assert.equal(b.state().startPending, false);
});

test('disposal during audio encoding does not begin a new host request afterwards', async () => {
  const reader = deferred();
  const b = browser({ engine: 'cloud-asr', readerDelay: reader.promise });
  await b.api.startRecording();
  b.recorders[0].data();
  b.api.stopRecording();
  await flush();
  b.api.unmountHotkey();
  reader.resolve();
  await flush();
  assert.equal(b.requests.length, 0);
  assert.equal(b.draft, 'draft');
});

test('cancelling a pending unavailable device does not open a fallback microphone request', async () => {
  const permission = deferred();
  let calls = 0;
  const b = browser({ engine: 'cloud-asr', getUserMedia: () => { calls++; return permission.promise; } });
  b.face.writeDeviceId('unplugged');
  const start = b.api.startRecording();
  b.api.onWindowBlur();
  permission.reject(Object.assign(new Error('device gone'), { name: 'OverconstrainedError' }));
  assert.equal(await start, false);
  assert.equal(calls, 1);
  assert.equal(b.state().startPending, false);
  assert.equal(b.status, '已取消');
});
