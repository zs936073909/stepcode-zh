#!/usr/bin/env node
// Pass 1: apply the quoted-string translation tables (i18n/zh_*.json).
//
//   node scripts/patch.js [build/step_bundle.js] [-o build/step_bundle.zh.js] [--lenient]
//
// Every occurrence of  "<key>"  (or '<key>') is replaced with the translation. Both quote
// styles and both escape forms are handled, and ALL of them are replaced — not just the
// first form that happens to match, which silently dropped the other quoting.
//
// The bundle must keep its exact byte length so every module offset inside the binary
// stays valid; the difference is absorbed by trailing whitespace at EOF.
import fs from "node:fs";
import path from "node:path";
import { ROOT, validateValue } from "./lib.js";

const args = process.argv.slice(2);
let inFile = path.join(ROOT, "build", "step_bundle.js");
let outFile = path.join(ROOT, "build", "step_bundle.zh.js");
let lenient = false;
for (let i = 0; i < args.length; i++) {
	if (args[i] === "-o") outFile = args[++i];
	else if (args[i] === "--lenient") lenient = true;
	else if (!args[i].startsWith("-")) inFile = args[i];
}

let buf = fs.readFileSync(inFile);
const origLen = buf.length;

// ---- load tables ------------------------------------------------------------------
const map = new Map();
const i18nDir = path.join(ROOT, "i18n");
for (const f of fs.readdirSync(i18nDir).filter((f) => /^zh_\d+\.json$/.test(f)).sort()) {
	for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(i18nDir, f), "utf8")))) {
		if (map.has(k) && map.get(k) !== v) throw new Error(`conflicting translation for ${JSON.stringify(k)}`);
		map.set(k, v);
	}
}
console.log(`translations loaded: ${map.size}`);

// ---- escaping ---------------------------------------------------------------------
function jsEscape(s, quote) {
	let out = "";
	for (const ch of s) {
		const code = ch.codePointAt(0);
		if (ch === quote) { out += `\\${ch}`; continue; }
		if (ch === "\\") { out += "\\\\"; continue; }
		if (ch === "\n") { out += "\\n"; continue; }
		if (ch === "\r") { out += "\\r"; continue; }
		if (ch === "\t") { out += "\\t"; continue; }
		if (code < 0x20) { out += `\\u${code.toString(16).padStart(4, "0")}`; continue; }
		out += ch;
	}
	return out;
}
// The bundler sometimes emits non-ASCII as \uXXXX; support matching that form too.
function jsEscapeAscii(s, quote) {
	let out = "";
	for (const ch of s) {
		const code = ch.codePointAt(0);
		if (ch === quote) { out += `\\${ch}`; continue; }
		if (ch === "\\") { out += "\\\\"; continue; }
		if (ch === "\n") { out += "\\n"; continue; }
		if (ch === "\r") { out += "\\r"; continue; }
		if (ch === "\t") { out += "\\t"; continue; }
		if (code < 0x20 || code > 0x7e) { out += `\\u${code.toString(16).padStart(4, "0")}`; continue; }
		out += ch;
	}
	return out;
}

// ---- apply ------------------------------------------------------------------------
// Collect every (needle, replacement) pair first, then apply them in one sweep per key.
// Replacing only the first matching form was the old bug: when the same English string
// appeared with both quote styles, one of them was silently left in English while the
// replacement count still looked plausible.
let applied = 0;
const missing = [];
const rejected = [];
for (const [en, zh] of map) {
	// Values are re-escaped here, so this pass is safe by construction; validate anyway so
	// a bad table is reported once instead of surfacing as a broken bundle.
	const errs = validateValue(en, zh, "dq").filter((e) => !e.includes("double quote"));
	if (errs.length > 0) { rejected.push([en, errs]); continue; }

	const forms = [];
	for (const q of ['"', "'"]) {
		forms.push([Buffer.from(`${q}${jsEscape(en, q)}${q}`, "utf8"), q]);
		forms.push([Buffer.from(`${q}${jsEscapeAscii(en, q)}${q}`, "utf8"), q]);
	}
	let replacedThisKey = 0;
	for (const [needle, quote] of forms) {
		const positions = [];
		let idx = -1;
		while ((idx = buf.indexOf(needle, idx + 1)) !== -1) {
			if (idx > 0 && buf[idx - 1] === 0x5c) continue; // escaped quote inside another string
			positions.push(idx);
		}
		if (positions.length === 0) continue;
		const repl = Buffer.from(`${quote}${jsEscape(zh, quote)}${quote}`, "utf8");
		const out = [];
		let p = 0;
		for (const pos of positions) { out.push(buf.slice(p, pos), repl); p = pos + needle.length; }
		out.push(buf.slice(p));
		buf = Buffer.concat(out);
		replacedThisKey += positions.length;
	}
	if (replacedThisKey === 0) missing.push(en);
	else applied += replacedThisKey;
}

for (const [en, errs] of rejected) console.error(`  REJECTED ${JSON.stringify(en)}: ${errs.join("; ")}`);
console.log(`replacements applied: ${applied}   missing: ${missing.length}   rejected: ${rejected.length}`);

// A missing key means the upstream copy changed under us. That is exactly the silent
// half-translation this tool exists to prevent, so it fails the build by default.
if (missing.length > 0) {
	console.error(`${missing.length} translation key(s) no longer match this build:`);
	for (const m of missing) console.error(`  not found: ${JSON.stringify(m)}`);
	if (!lenient) {
		console.error("refusing to produce a partially translated binary (pass --lenient to override)");
		process.exit(1);
	}
}
if (rejected.length > 0) process.exit(1);

// ---- write the intermediate --------------------------------------------------------
// No padding here: pass 2 may grow or shrink the text, and only the final result has to
// match the original byte length. Doing the pad once at the end removes a whole class of
// "not enough pad to shrink" failures.
const delta = origLen - buf.length;
if (delta < 0) {
	console.error(`pass 1 alone made the bundle ${-delta} bytes LONGER than the original`);
	process.exit(1);
}
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, buf);
fs.writeFileSync(path.join(path.dirname(outFile), ".state.json"), `${JSON.stringify({ origLen }, null, 1)}\n`);
console.log(`written: ${outFile}  (${buf.length} bytes, ${delta} shorter than the original)`);
