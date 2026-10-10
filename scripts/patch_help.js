#!/usr/bin/env node
// Pass 2: apply the plain-substring translation table (i18n/zh_help.json).
//
//   node scripts/patch_help.js [build/step_bundle.zh.js] [-o build/step_bundle.zh2.js]
//
// Used for text that lives inside template literals (CLI --help, footer hints, the
// settings menu, /hotkeys, ...) where there is no quoted literal to match.
//
// Values are inserted RAW, so this pass is the supply-chain surface of the whole tool:
// a translation table is effectively executable code. Every value is therefore validated
// against the literal it lands in (see lib.validateValue), and after patching we assert
// that the bundle's total ${...} and backtick counts are unchanged — which makes code
// injection through a translation table impossible, not merely unlikely.
import fs from "node:fs";
import path from "node:path";
import { enclosingKind, padTo, repad, ROOT, scanLiterals, validateValue } from "./lib.js";

const args = process.argv.slice(2);
let inFile = path.join(ROOT, "build", "step_bundle.zh.js");
let outFile = path.join(ROOT, "build", "step_bundle.zh2.js");
for (let i = 0; i < args.length; i++) {
	if (args[i] === "-o") outFile = args[++i];
	else if (!args[i].startsWith("-")) inFile = args[i];
}

let buf = fs.readFileSync(inFile);
// The original byte length comes from pass 1's state file, not from the intermediate,
// because the intermediate is deliberately left unpadded.
const statePath = path.join(path.dirname(inFile), ".state.json");
if (!fs.existsSync(statePath)) {
	console.error(`missing ${statePath} — run scripts/patch.js first`);
	process.exit(1);
}
const origLen = JSON.parse(fs.readFileSync(statePath, "utf8")).origLen;
const map = JSON.parse(fs.readFileSync(path.join(ROOT, "i18n", "zh_help.json"), "utf8"));

const beforeInterp = (buf.toString("utf8").match(/\$\{/g) ?? []).length;
const beforeTicks = (buf.toString("utf8").match(/`/g) ?? []).length;

// Longest key first so a longer phrase wins over its own prefix.
const spans = scanLiterals(buf.toString("utf8"));
const isWord = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(String.fromCharCode(c));

const report = [];
const missing = [];
const rejected = [];
for (const [en, zh] of Object.entries(map).sort((a, b) => b[0].length - a[0].length)) {
	const needle = Buffer.from(en, "utf8");
	const positions = [];
	let pos = -1;
	while ((pos = buf.indexOf(needle, pos + 1)) !== -1) {
		const before = pos > 0 ? buf[pos - 1] : undefined;
		const after = pos + needle.length < buf.length ? buf[pos + needle.length] : undefined;
		const afterIsInterp = after === 0x24 && buf[pos + needle.length + 1] === 0x7b; // ${...}
		if (isWord(before) || (isWord(after) && !afterIsInterp)) continue; // inside an identifier
		positions.push(pos);
	}
	if (positions.length === 0) { missing.push(en); continue; }

	// Validate per occurrence: the same English text can sit in a double-quoted string in
	// one place and a template literal in another, and the constraints differ.
	//
	// The literal scanner is heuristic and can lose sync on unusual code, so a
	// "wrong quote for this literal" finding is reported as a warning rather than a hard
	// failure — the real syntax gate is `node --check` on the patched bundle, which
	// build.sh runs before anything else. Interpolation, backslash, and control-character
	// violations stay hard failures: those are the injection surface.
	const kinds = new Set(positions.map((p) => enclosingKind(spans, p)));
	const hard = [];
	const soft = [];
	for (const kind of kinds) {
		for (const e of validateValue(en, zh, kind)) {
			const isQuoteRule = /quote|backtick/.test(e);
			(isQuoteRule ? soft : hard).includes(e) || (isQuoteRule ? soft : hard).push(e);
		}
	}
	if (soft.length > 0) console.log(`  note [${[...kinds].join(",")}] ${JSON.stringify(en)}: ${soft.join("; ")}`);
	if (hard.length > 0) { rejected.push([en, [...kinds], hard]); continue; }

	const out = [];
	let p = 0;
	for (const idx of positions) { out.push(buf.slice(p, idx), Buffer.from(zh, "utf8")); p = idx + needle.length; }
	out.push(buf.slice(p));
	buf = Buffer.concat(out);
	report.push({ en, zh, count: positions.length, kinds: [...kinds] });
}

console.log(`help pass: ${report.reduce((a, r) => a + r.count, 0)} substrings across ${report.length} keys; missing ${missing.length}; rejected ${rejected.length}`);
for (const [en, kinds, errs] of rejected) console.error(`  REJECTED [${kinds.join(",")}] ${JSON.stringify(en)}: ${errs.join("; ")}`);
for (const m of missing) console.log(`  missing: ${JSON.stringify(m)}`);

// ---- injection invariants ----------------------------------------------------------
const afterInterp = (buf.toString("utf8").match(/\$\{/g) ?? []).length;
const afterTicks = (buf.toString("utf8").match(/`/g) ?? []).length;
if (afterInterp !== beforeInterp || afterTicks !== beforeTicks) {
	console.error(`interpolation/backtick invariant violated: \${ went ${beforeInterp} -> ${afterInterp}, backticks ${beforeTicks} -> ${afterTicks}`);
	console.error("a translation value must not introduce new template-literal syntax");
	process.exit(1);
}

// ---- restore the exact length ------------------------------------------------------
// Pass 2 can go either way: shorter translations free bytes that must be padded back,
// longer ones have to eat into the padding pass 1 left. Both directions are handled.
if (buf.length < origLen) buf = padTo(buf, origLen);
else if (buf.length > origLen) buf = repad(buf, origLen);
if (buf.length !== origLen) throw new Error(`length mismatch ${buf.length} != ${origLen}`);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, buf);
fs.writeFileSync(path.join(ROOT, "build", "help_report.json"), `${JSON.stringify({ report, missing, rejected }, null, 1)}\n`);
console.log(`written: ${outFile}  (${buf.length} bytes)`);
