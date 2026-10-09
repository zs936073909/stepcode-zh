#!/usr/bin/env node
// Extract the embedded JavaScript bundle from a `step` (StepCode) standalone binary.
//
//   node scripts/extract.js [path-to-step-binary] [-o out.js]
//
// Default binary: $STEPCODE_BIN or ~/.stepcode/bin/step
// Default output: build/step_bundle.js
//
// StepCode ships as a `bun build --compile` executable. The application code lives in an
// uncompressed JS bundle inside the binary's $bunfs virtual filesystem, stored as
//   \0/$bunfs/root/step\0<bundle bytes>
// We locate that entry and slice the bundle out.
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
let bin = process.env.STEPCODE_BIN;
let out = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') out = args[++i];
  else if (!args[i].startsWith('-')) bin = args[i];
}
if (!bin) bin = path.join(os.homedir(), '.stepcode', 'bin', 'step');
if (!fs.existsSync(bin)) {
  console.error('binary not found: ' + bin);
  console.error('usage: node scripts/extract.js [/path/to/step] [-o out.js]');
  process.exit(1);
}
if (!out) out = path.join(__dirname, '..', 'build', 'step_bundle.js');

const data = fs.readFileSync(bin);
const marker = Buffer.from('\x00/$bunfs/root/step\x00');
const at = data.indexOf(marker);
if (at < 0) {
  console.error('could not find /$bunfs/root/step inside ' + bin);
  process.exit(1);
}
const start = at + marker.length;

// The bundle runs until the next $bunfs entry (another \0/$bunfs/ path).
const nextEntry = data.indexOf(Buffer.from('\x00/$bunfs/'), start);
const end = nextEntry < 0 ? data.length : nextEntry;

if (!data.slice(start, start + 19).toString('utf8').startsWith('#!/usr/bin/env node')) {
  console.error('unexpected bundle header: ' + JSON.stringify(data.slice(start, start + 24).toString('utf8')));
  process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, data.slice(start, end));
console.log('binary      : ' + bin + '  (' + data.length + ' bytes)');
console.log('bundle range: ' + start + ' .. ' + end + '  (' + (end - start) + ' bytes)');
console.log('written     : ' + out);
