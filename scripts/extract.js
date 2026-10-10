#!/usr/bin/env node
// Extract the embedded JavaScript bundle from a `step` (StepCode) standalone binary,
// and record what it was taken from so a later build can tell whether the translation
// tables still apply.
//
//   node scripts/extract.js [path-to-step-binary] [-o out.js]
//
// Default binary: $STEPCODE_BIN or ~/.stepcode/bin/step
//
// StepCode ships as a `bun build --compile` executable. The application code lives in an
// uncompressed JS bundle inside the binary's $bunfs virtual filesystem, stored as
//   \0/$bunfs/root/step\0<bundle bytes>
//
// The end of the bundle is NOT guessed: Bun records the module length in the trailer
// table near the end of the file. We compute the length from the next $bunfs entry and
// then require an independent match against that recorded value before accepting it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, sha256 } from "./lib.js";

const args = process.argv.slice(2);
let bin = process.env.STEPCODE_BIN;
let out = null;
let allowUnverified = false;
for (let i = 0; i < args.length; i++) {
	if (args[i] === "-o") out = args[++i];
	else if (args[i] === "--allow-unverified-end") allowUnverified = true;
	else if (!args[i].startsWith("-")) bin = args[i];
}
if (!bin) bin = path.join(os.homedir(), ".stepcode", "bin", "step");
if (!fs.existsSync(bin)) {
	console.error(`binary not found: ${bin}`);
	console.error("usage: node scripts/extract.js [/path/to/step] [-o out.js] [--allow-unverified-end]");
	process.exit(1);
}
if (!out) out = path.join(ROOT, "build", "step_bundle.js");

// --- version anchor ---------------------------------------------------------------
let version = "unknown";
try {
	version = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 60_000 }).trim();
} catch (error) {
	console.error(`warning: could not read \`step --version\`: ${error}`);
}

const data = fs.readFileSync(bin);
const binarySha = sha256(data);

// --- locate the bundle ------------------------------------------------------------
const marker = Buffer.from("\x00/$bunfs/root/step\x00");
const at = data.indexOf(marker);
if (at < 0) {
	console.error(`could not find /$bunfs/root/step inside ${bin}`);
	process.exit(1);
}
const start = at + marker.length;
const nextEntry = data.indexOf(Buffer.from("\x00/$bunfs/"), start);
const end = nextEntry < 0 ? data.length : nextEntry;
const length = end - start;

if (!data.slice(start, start + 19).toString("utf8").startsWith("#!/usr/bin/env node")) {
	console.error(`unexpected bundle header: ${JSON.stringify(data.slice(start, start + 24).toString("utf8"))}`);
	process.exit(1);
}

// --- confirm the length against Bun's own recorded value ---------------------------
// The trailer table near EOF stores the module length. Searching the tail for the
// little-endian encoding of our computed length gives an independent confirmation that
// the "next $bunfs entry" boundary is the real one rather than an accident of the bytes.
function findRecordedLengths(value) {
	const hits = [];
	// The trailer stores the length as a little-endian integer; probe the two widths a
	// module of this size can plausibly use.
	if (value <= 0xffffffff) {
		const buf = Buffer.alloc(4);
		buf.writeUInt32LE(value, 0);
		collect(buf, 4);
	}
	const wide = Buffer.alloc(8);
	wide.writeBigUInt64LE(BigInt(value));
	collect(wide, 8);
	function collect(buf, width) {
		let i = -1;
		while (true) {
			i = data.indexOf(buf, i + 1);
			if (i < 0) break;
			if (!hits.some((h) => Math.abs(h.offset - i) < width)) hits.push({ offset: i, width });
		}
	}
	return hits;
}
const tail = data.length - Math.min(data.length, 8192);
const recorded = findRecordedLengths(length).filter((h) => h.offset >= tail);
const verified = recorded.length > 0;
if (!verified && !allowUnverified) {
	console.error("could not confirm the bundle length against the value Bun records in the trailer.");
	console.error(`  computed length : ${length}`);
	console.error("  this binary may use a layout this tool does not understand; refusing to guess.");
	console.error("  re-run with --allow-unverified-end if you have checked it by hand.");
	process.exit(1);
}

// --- sanity checks -----------------------------------------------------------------
const bundle = data.slice(start, end);
if (bundle.includes(0)) {
	console.error("extracted bundle contains a NUL byte: the end boundary is wrong");
	process.exit(1);
}
// Guard against double patching: if the bundle already carries CJK, this binary has been
// through the tool once and patching it again would layer translations on translations.
if (/[\u4e00-\u9fff]/.test(bundle.toString("utf8"))) {
	console.error("the extracted bundle already contains Chinese characters.");
	console.error(`${bin} looks like an already-patched binary — patch the original instead.`);
	process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, bundle);

const manifest = {
	target: {
		binary: path.resolve(bin),
		version,
		sha256: binarySha,
		bundleSha256: sha256(bundle),
		bundleStart: start,
		bundleEnd: end,
		bundleLength: length,
		endConfirmedByTrailer: verified,
	},
};
fs.writeFileSync(path.join(ROOT, "build", "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);

console.log(`binary      : ${bin}`);
console.log(`version     : ${version}`);
console.log(`binary sha  : ${binarySha.slice(0, 16)}…`);
console.log(`bundle range: ${start} .. ${end}  (${length} bytes)`);
console.log(`end check   : ${verified ? `confirmed by trailer value at +${recorded[0].offset}` : "UNVERIFIED (--allow-unverified-end)"}`);
console.log(`written     : ${out}`);
