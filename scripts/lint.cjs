// scripts/lint.cjs — syntax-check all JS files WITHOUT shelling out.
//
// node --check used to be spawned through a process-spawn primitive that
// static scanners flag as high risk when they read the repository. The same check now runs through node:vm for every
// CommonJS-shaped file (tests, scripts, and the client bundle). The ESM lib
// files (lib/index.js, lib/host-utils.js, lib/local-asr.js) are loaded by the
// test suite (tests/run-tests.cjs imports each of them), so their syntax is
// covered by "npm test" — CI runs both.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.nyc_output']);
const ROOT = path.join(__dirname, '..');
/** Browser bundle: CJS-shaped (no import/export statements) despite the
 *  package-wide "type": "module" — vm.Script is a valid syntax check for it. */
const EXTRA_FILES = new Set([path.join(ROOT, 'lib', 'client.js')]);

function findCjs(dir, acc = []) {
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('.tmp')) continue;
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(f)) findCjs(p, acc);
    } else if (f.endsWith('.cjs')) {
      acc.push(p);
    }
  }
  return acc;
}

const files = findCjs(ROOT).concat([...EXTRA_FILES].filter((p) => fs.existsSync(p)));
let failed = 0;
for (const f of files) {
  try {
    new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f });
  } catch (error) {
    console.error('LINT FAIL:', path.relative(ROOT, f), '—', error && error.message);
    failed++;
  }
}
if (failed) {
  console.error(failed + ' file(s) failed');
  process.exit(1);
}
console.log('Lint OK:', files.length, 'files (ESM lib modules are covered by npm test)');
