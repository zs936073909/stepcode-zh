#!/usr/bin/env node
// Safety audit: flag translation keys whose English text is also used by the program for
// matching (===, .includes(), object keys, env values, ...). Translating those breaks
// logic, so they must either stay English or be replaced with a more specific key.
//
//   node scripts/audit.js [build/step_bundle.js]
//
// Both passes are audited: quoted literals (i18n/zh_*.json) and raw substrings
// (i18n/zh_help.json), because the latter is where a translation can reach into code.
//
// Findings are not automatically bugs. If BOTH sides of a comparison use the same
// literal — a select() option array plus `choice === "Cancel"` — replacing both keeps
// them consistent and it is safe. Those cases belong in i18n/audit-allowlist.json with a
// reason; anything NEW fails the build, which is what stops a careless PR from silently
// breaking a machine-parsed string.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib.js";

const args = process.argv.slice(2);
const inFile = args.find((a) => !a.startsWith("-")) || path.join(ROOT, "build", "step_bundle.js");
const src = fs.readFileSync(inFile, "utf8");

const keys = new Set();
const i18nDir = path.join(ROOT, "i18n");
for (const f of fs.readdirSync(i18nDir).filter((f) => /^zh_\d+\.json$/.test(f)).sort()) {
	for (const k of Object.keys(JSON.parse(fs.readFileSync(path.join(i18nDir, f), "utf8")))) keys.add(k);
}
const helpKeys = Object.keys(JSON.parse(fs.readFileSync(path.join(i18nDir, "zh_help.json"), "utf8")));

let allowlist = {};
const allowPath = path.join(i18nDir, "audit-allowlist.json");
if (fs.existsSync(allowPath)) allowlist = JSON.parse(fs.readFileSync(allowPath, "utf8"));

// Patterns that mean "the program compares against this text".
const DANGER = [
	/\.(includes|startsWith|endsWith|indexOf|match|test|split|replace|replaceAll|normalize)\($/,
	/new Set\(\[?$/,
	/\bin$/,
	/(===|!==)$/,
];

const lines = src.split("\n");
const lineStarts = [];
{ let acc = 0; for (const l of lines) { lineStarts.push(acc); acc += l.length + 1; } }
function lineOf(pos) {
	let lo = 0, hi = lines.length - 1, r = 0;
	while (lo <= hi) { const m = (lo + hi) >> 1; if (lineStarts[m] <= pos) { r = m; lo = m + 1; } else hi = m - 1; }
	return r;
}

const findings = [];

// --- pass 1: quoted literals --------------------------------------------------------
for (const k of keys) {
	const needle = JSON.stringify(k).slice(1, -1);
	let pos = -1;
	while ((pos = src.indexOf(needle, pos + 1)) !== -1) {
		if (src[pos - 1] !== '"' && src[pos - 1] !== "'") continue;
		if (src[pos + needle.length] !== '"' && src[pos + needle.length] !== "'") continue;
		const li = lineOf(pos);
		const before = lines[li]
			.slice(0, pos - lineStarts[li])
			.replace(/\s+$/, "")
			.replace(/["']$/, "")
			.replace(/\s+$/, "");
		const why = DANGER.find((re) => re.test(before));
		if (why) findings.push({ pass: 1, key: k, line: li + 1, ctx: lines[li].trim().slice(0, 150) });
	}
}

// --- pass 2: raw substrings ---------------------------------------------------------
// A substring key that lands in code (not inside a literal) is executable text.
for (const k of helpKeys) {
	const needle = k;
	let pos = -1;
	while ((pos = src.indexOf(needle, pos + 1)) !== -1) {
		const li = lineOf(pos);
		const line = lines[li];
		const before = line.slice(0, pos - lineStarts[li]).replace(/\s+$/, "");
		const why = DANGER.find((re) => re.test(before));
		if (why) findings.push({ pass: 2, key: k, line: li + 1, ctx: line.trim().slice(0, 150) });
	}
}

const byKey = new Map();
for (const f of findings) {
	if (!byKey.has(f.key)) byKey.set(f.key, []);
	byKey.get(f.key).push(f);
}

const allowed = new Set(Object.keys(allowlist));
const unexpected = [];
for (const [k, arr] of byKey) {
	const isAllowed = allowed.has(k);
	console.log(`${isAllowed ? "~ (allowlisted)" : "!"} ${JSON.stringify(k)}`);
	for (const a of arr.slice(0, 5)) console.log(`     L${a.line} [pass ${a.pass}]  ${a.ctx}`);
	if (!isAllowed) unexpected.push(k);
}

if (unexpected.length > 0) {
	console.error(`\n${unexpected.length} key(s) reach code that the program matches against:`);
	for (const k of unexpected) console.error(`  - ${JSON.stringify(k)}`);
	console.error("Either drop the translation, narrow the key, or add it to i18n/audit-allowlist.json with a reason.");
	process.exit(1);
}
console.log(`\naudit passed: ${byKey.size} risky key(s), all allowlisted with a reason.`);
