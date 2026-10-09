#!/usr/bin/env node
// Safety audit: flag translation keys whose English text is also used by the program for
// matching (===, .includes(), object keys, env values, ...). Translating those breaks logic.
//
//   node scripts/audit.js [build/step_bundle.js]
//
// A finding is not automatically a bug: if BOTH sides of a comparison use the same literal
// (e.g. a select() option array plus `choice === "Cancel"`), replacing both keeps them
// consistent and it is safe. The audit output is for manual review.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const inFile = args.find(a => !a.startsWith('-')) || path.join(ROOT, 'build', 'step_bundle.js');
const src = fs.readFileSync(inFile, 'utf8');

const keys = new Set();
const i18nDir = path.join(ROOT, 'i18n');
for (const f of fs.readdirSync(i18nDir).filter(f => /^zh_\d+\.json$/.test(f)).sort()) {
  for (const k of Object.keys(JSON.parse(fs.readFileSync(path.join(i18nDir, f), 'utf8')))) keys.add(k);
}
for (const k of Object.keys(JSON.parse(fs.readFileSync(path.join(i18nDir, 'zh_help.json'), 'utf8')))) keys.add(k);

const DANGER = [
  /\.(includes|startsWith|endsWith|indexOf|match|test|split|replace|replaceAll|normalize)\($/,
  /new Set\(\[?$/,
  /\bin$/,
  /(===|!==)$/,
];
const lines = src.split('\n');
const lineStarts = [];
{ let acc = 0; for (const l of lines) { lineStarts.push(acc); acc += l.length + 1; } }
function lineOf(pos) { let lo = 0, hi = lines.length - 1, r = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (lineStarts[m] <= pos) { r = m; lo = m + 1; } else hi = m - 1; } return r; }

const findings = [];
for (const k of keys) {
  const needle = JSON.stringify(k).slice(1, -1);
  let pos = -1;
  while ((pos = src.indexOf(needle, pos + 1)) !== -1) {
    if (src[pos - 1] !== '"' && src[pos - 1] !== "'") continue;
    if (src[pos + needle.length] !== '"' && src[pos + needle.length] !== "'") continue;
    const li = lineOf(pos);
    const before = lines[li].slice(0, pos - lineStarts[li]).replace(/\s+$/, '').replace(/["']$/, '').replace(/\s+$/, '');
    const why = DANGER.find(re => re.test(before));
    if (why) findings.push({ key: k, line: li + 1, ctx: lines[li].trim().slice(0, 150) });
  }
}
const byKey = new Map();
for (const f of findings) { if (!byKey.has(f.key)) byKey.set(f.key, []); byKey.get(f.key).push(f); }
for (const [k, arr] of byKey) {
  console.log('### ' + JSON.stringify(k));
  for (const a of arr.slice(0, 5)) console.log('   L' + a.line + '  ' + a.ctx);
}
console.log('keys with risky contexts: ' + byKey.size);
