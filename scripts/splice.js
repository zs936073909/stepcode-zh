#!/usr/bin/env node
// Splice the patched bundle back into a copy of the step binary.
//
//   node scripts/splice.js [path-to-step-binary] [-o out-binary]
//
// The bundle is written back at exactly the same offset, so every module offset and the
// Bun trailer stay valid. The output is byte-identical to the input outside the bundle.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./lib.js";

const args = process.argv.slice(2);
let bin = process.env.STEPCODE_BIN;
let out = null;
for (let i = 0; i < args.length; i++) {
	if (args[i] === "-o") out = args[++i];
	else if (!args[i].startsWith("-")) bin = args[i];
}
if (!bin) bin = path.join(os.homedir(), ".stepcode", "bin", "step");
if (!out) out = path.join(ROOT, "build", "step.zh");

const bundle = fs.readFileSync(path.join(ROOT, "build", "step_bundle.zh2.js"));
const orig = fs.readFileSync(bin);

const marker = Buffer.from("\x00/$bunfs/root/step\x00");
const at = orig.indexOf(marker);
if (at < 0) {
	console.error(`could not find /$bunfs/root/step inside ${bin}`);
	process.exit(1);
}
const START = at + marker.length;
const nextEntry = orig.indexOf(Buffer.from("\x00/$bunfs/"), START);
const END = nextEntry < 0 ? orig.length : nextEntry;

if (bundle.length !== END - START) {
	console.error(`bundle length ${bundle.length} != embedded range ${END - START}`);
	console.error("the patched bundle must be byte-for-byte the same length as the original");
	process.exit(1);
}
const out2 = Buffer.concat([orig.slice(0, START), bundle, orig.slice(END)]);
if (out2.length !== orig.length) throw new Error("size mismatch");
for (let i = 0; i < START; i++) if (out2[i] !== orig[i]) throw new Error(`diff before bundle at ${i}`);
for (let i = END; i < orig.length; i++) if (out2[i] !== orig[i]) throw new Error(`diff after bundle at ${i}`);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, out2);
fs.chmodSync(out, 0o755);
console.log(`binary : ${bin}  (${orig.length} bytes)`);
console.log(`written: ${out}  (${out2.length} bytes)`);
