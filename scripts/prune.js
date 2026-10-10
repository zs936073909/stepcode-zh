#!/usr/bin/env node
// Table hygiene: drop i18n/zh_help.json keys that no longer match the pass-1 output.
//
//   node scripts/prune.js [--apply]
//
// A key goes stale when an earlier pass already replaced the text it was meant to match —
// typically a quoted literal covered by i18n/zh_*.json, or a longer phrase that another
// key subsumed. Stale keys are harmless at run time but they hide real drift: when
// upstream rewrites a label you want the missing-key report to be about that, not about
// entries that were redundant from the start.
//
// Dry run by default; --apply rewrites the table.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib.js";

const apply = process.argv.includes("--apply");
const p1 = path.join(ROOT, "build", "step_bundle.zh.js");
if (!fs.existsSync(p1)) {
	console.error(`missing ${p1} — run scripts/patch.js first`);
	process.exit(1);
}
const buf = fs.readFileSync(p1);
const tablePath = path.join(ROOT, "i18n", "zh_help.json");
const table = JSON.parse(fs.readFileSync(tablePath, "utf8"));

const isWord = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(String.fromCharCode(c));
const stale = [];
for (const en of Object.keys(table)) {
	const needle = Buffer.from(en, "utf8");
	let pos = -1;
	let found = false;
	while ((pos = buf.indexOf(needle, pos + 1)) !== -1) {
		const before = pos > 0 ? buf[pos - 1] : undefined;
		const after = pos + needle.length < buf.length ? buf[pos + needle.length] : undefined;
		const afterIsInterp = after === 0x24 && buf[pos + needle.length + 1] === 0x7b;
		if (isWord(before) || (isWord(after) && !afterIsInterp)) continue;
		found = true;
		break;
	}
	if (!found) stale.push(en);
}

if (stale.length === 0) {
	console.log("no stale keys");
	process.exit(0);
}
console.log(`${stale.length} stale key(s) in i18n/zh_help.json:`);
for (const k of stale) console.log(`  ${JSON.stringify(k)}`);
if (!apply) {
	console.log("\ndry run — re-run with --apply to remove them");
	process.exit(0);
}
for (const k of stale) delete table[k];
fs.writeFileSync(tablePath, `${JSON.stringify(table, null, 1)}\n`);
console.log(`\nremoved ${stale.length}; ${Object.keys(table).length} keys remain`);
