// scripts/lint.js — syntax-check all JS files (node --check)
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.nyc_output']);
const ROOT = path.join(__dirname, '..');

function findJs(dir, acc = []) {
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('.tmp')) continue;
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(f)) findJs(p, acc);
    } else if (f.endsWith('.js')) acc.push(p);
  }
  return acc;
}

const files = findJs(ROOT);
let failed = 0;
for (const f of files) {
  try { execSync('node --check "' + f + '"', { stdio: 'ignore' }); }
  catch (e) { console.error('LINT FAIL:', f); failed++; }
}
if (failed) { console.error(failed + ' file(s) failed'); process.exit(1); }
console.log('Lint OK:', files.length, 'files');
