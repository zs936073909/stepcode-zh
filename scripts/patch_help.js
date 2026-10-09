#!/usr/bin/env node
// Pass 2: apply the plain-substring translation table (i18n/zh_help.json).
//
//   node scripts/patch_help.js [build/step_bundle.zh.js] [-o build/step_bundle.zh2.js]
//
// Used for text that lives inside template literals (CLI --help, footer hints, settings menu,
// trust prompt, ...) where there is no quoted literal to match. Keys are sorted longest-first
// so a longer phrase wins over its prefix, and matches that sit inside a longer identifier are
// skipped (word-boundary guard).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
let inFile = path.join(ROOT, 'build', 'step_bundle.zh.js');
let outFile = path.join(ROOT, 'build', 'step_bundle.zh2.js');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') outFile = args[++i];
  else if (!args[i].startsWith('-')) inFile = args[i];
}

let buf = fs.readFileSync(inFile);
const origLen = buf.length;
const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'zh_help.json'), 'utf8'));

const isWord = c => c !== undefined && /[A-Za-z0-9_$]/.test(String.fromCharCode(c));
const report = [];
const missing = [];
for (const [en, zh] of Object.entries(map).sort((a, b) => b[0].length - a[0].length)) {
  const needle = Buffer.from(en, 'utf8');
  const positions = [];
  let pos = -1;
  while ((pos = buf.indexOf(needle, pos + 1)) !== -1) {
    const before = pos > 0 ? buf[pos - 1] : undefined;
    const after = pos + needle.length < buf.length ? buf[pos + needle.length] : undefined;
    const afterIsInterp = after === 0x24 && buf[pos + needle.length + 1] === 0x7b; // ${...}
    if (isWord(before) || (isWord(after) && !afterIsInterp)) continue;             // inside an identifier
    positions.push(pos);
  }
  if (positions.length === 0) { missing.push(en); continue; }
  const out = [];
  let p = 0;
  for (const idx of positions) { out.push(buf.slice(p, idx), Buffer.from(zh, 'utf8')); p = idx + needle.length; }
  out.push(buf.slice(p));
  buf = Buffer.concat(out);
  report.push({ en, zh, count: positions.length });
}
console.log('help pass: ' + report.reduce((a, r) => a + r.count, 0) + ' substrings across ' + report.length + ' keys; missing ' + missing.length);
for (const m of missing) console.log('  missing: ' + JSON.stringify(m));

// resize the trailing pad comment written by patch.js
function adjustPad(buf, targetLen) {
  let end = buf.length, i = end;
  while (i > 0 && buf[i - 1] === 0x20) i--;
  if (i >= 3 && buf[i - 3] === 0x0a && buf[i - 2] === 0x2f && buf[i - 1] === 0x2f) {
    const commentStart = i - 3;
    const need = targetLen - commentStart;
    if (need < 3) throw new Error('no room for pad comment (need ' + need + ')');
    const comment = Buffer.from('\n//' + ' '.repeat(need - 3), 'utf8');
    if (comment.length !== need) throw new Error('pad mismatch');
    return Buffer.concat([buf.slice(0, commentStart), comment]);
  }
  throw new Error('trailing pad comment not found');
}
const delta = buf.length - origLen;
console.log('delta after help pass: ' + delta);
if (delta !== 0) buf = adjustPad(buf, origLen);
if (buf.length !== origLen) throw new Error('length mismatch ' + buf.length + ' != ' + origLen);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, buf);
console.log('written: ' + outFile + '  (' + buf.length + ' bytes)');
