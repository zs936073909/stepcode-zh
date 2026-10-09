#!/usr/bin/env node
// Pass 1: apply the quoted-string translation tables (i18n/zh_*.json) to the extracted bundle.
//
//   node scripts/patch.js [build/step_bundle.js] [-o build/step_bundle.zh.js]
//
// Each key is an English string literal; every occurrence of  "<key>"  (or '<key>') in the
// bundle is replaced with the Chinese translation. Because the replacement is byte-exact and
// in place, the total length changes; the difference is absorbed by a trailing `//` comment so
// the bundle keeps its original size and every module offset in the binary stays valid.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
let inFile = path.join(ROOT, 'build', 'step_bundle.js');
let outFile = path.join(ROOT, 'build', 'step_bundle.zh.js');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') outFile = args[++i];
  else if (!args[i].startsWith('-')) inFile = args[i];
}

let buf = fs.readFileSync(inFile);
const origLen = buf.length;

// ---- load translation tables -------------------------------------------------
const map = new Map();
const i18nDir = path.join(ROOT, 'i18n');
for (const f of fs.readdirSync(i18nDir).filter(f => /^zh_\d+\.json$/.test(f)).sort()) {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(i18nDir, f), 'utf8')))) {
    if (map.has(k) && map.get(k) !== v) throw new Error('conflicting translation for ' + JSON.stringify(k));
    map.set(k, v);
  }
}
console.log('translations loaded: ' + map.size);

// ---- string-literal escaping -------------------------------------------------
function jsEscape(s, quote) {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === quote) { out += '\\' + ch; continue; }
    if (ch === '\\') { out += '\\\\'; continue; }
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch === '\r') { out += '\\r'; continue; }
    if (ch === '\t') { out += '\\t'; continue; }
    if (code < 0x20) { out += '\\u' + code.toString(16).padStart(4, '0'); continue; }
    out += ch;
  }
  return out;
}
// The bundler sometimes emits non-ASCII as \uXXXX; support matching that form too.
function jsEscapeAscii(s, quote) {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === quote) { out += '\\' + ch; continue; }
    if (ch === '\\') { out += '\\\\'; continue; }
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch === '\r') { out += '\\r'; continue; }
    if (ch === '\t') { out += '\\t'; continue; }
    if (code < 0x20 || code > 0x7e) { out += '\\u' + code.toString(16).padStart(4, '0'); continue; }
    out += ch;
  }
  return out;
}

// ---- apply -------------------------------------------------------------------
let applied = 0;
const skipped = [];
for (const [en, zh] of map) {
  const variants = [];
  for (const q of ['"', "'"]) {
    variants.push(Buffer.from(q + jsEscape(en, q) + q, 'utf8'));
    variants.push(Buffer.from(q + jsEscapeAscii(en, q) + q, 'utf8'));
  }
  let chosen = null, count = 0;
  for (const v of variants) {
    let c = 0, idx = -1;
    while ((idx = buf.indexOf(v, idx + 1)) !== -1) {
      if (idx > 0 && buf[idx - 1] === 0x5c) continue; // escaped quote inside another string
      c++;
    }
    if (c > 0) { chosen = v; count = c; break; }
  }
  if (!chosen) { skipped.push(en); continue; }
  const quote = chosen[0] === 0x22 ? '"' : "'";
  const repl = Buffer.from(quote + jsEscape(zh, quote) + quote, 'utf8');
  const out = [];
  let pos = 0, idx;
  while ((idx = buf.indexOf(chosen, pos)) !== -1) {
    if (idx > 0 && buf[idx - 1] === 0x5c) continue;
    out.push(buf.slice(pos, idx), repl);
    pos = idx + chosen.length;
  }
  out.push(buf.slice(pos));
  buf = Buffer.concat(out);
  applied += count;
}

const delta = buf.length - origLen;
console.log('replacements applied: ' + applied + '   skipped: ' + skipped.length + '   byte delta: ' + delta);
for (const s of skipped) console.log('  not found: ' + JSON.stringify(s));

if (delta < 0) {
  const pad = -delta;
  const comment = Buffer.from('\n//' + ' '.repeat(Math.max(0, pad - 3)), 'utf8');
  if (comment.length !== pad) throw new Error('pad mismatch ' + comment.length + ' != ' + pad);
  buf = Buffer.concat([buf, comment]);
} else if (delta > 0) {
  throw new Error('translations made the bundle ' + delta + ' bytes LONGER - shorten some translations');
}
if (buf.length !== origLen) throw new Error('length mismatch: ' + buf.length + ' != ' + origLen);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, buf);
console.log('written: ' + outFile + '  (' + buf.length + ' bytes)');
