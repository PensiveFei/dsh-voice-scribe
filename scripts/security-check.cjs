// scripts/security-check.js — 密钥/隐私/路径扫描
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.nyc_output']);
const FILE_RE = /\.(js|md|yml|yaml|json|txt|example)$/i;
const PATTERNS = [
  [/api[_-]?key\s*[:=]\s*['"][^'"]+/i, 'API KEY pattern'],
  [/sk-[A-Za-z0-9]{20,}/, 'OpenAI-style key'],
  [/password\s*[:=]\s*['"][^'"]+/i, 'password pattern'],
  [/C:\\Users\\[^\\"' ]+/i, 'Windows user path'],
  [/C:\/Users\/[^"' ]+/i, 'Windows user path (forward slash)'],
  [/AKIA[0-9A-Z]{16}/, 'AWS key'],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key block']
];

function walk(dir, acc = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return acc; }
  for (const ent of entries) {
    if (ent.name.startsWith('.tmp')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(p, acc);
    } else if (FILE_RE.test(ent.name)) acc.push(p);
  }
  return acc;
}

function scanDir(dir) {
  const files = walk(dir);
  const issues = [];
  for (const f of files) {
    let c;
    try { c = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    for (const [re, label] of PATTERNS) {
      if (re.test(c)) issues.push(label + ' in ' + path.relative(dir, f));
    }
  }
  return issues;
}

if (require.main === module) {
  const issues = scanDir(process.cwd());
  if (issues.length === 0) { console.log('OK: no secrets/passwords/local user paths found'); }
  else { issues.forEach(i => console.log('ISSUE: ' + i)); process.exit(1); }
}

module.exports = { scanDir, walk, PATTERNS };
