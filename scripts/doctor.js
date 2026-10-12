#!/usr/bin/env node
// Doctor: work out what upstream changed after `step update --self`, and stage the
// translation work so a human only fills in Chinese.
//
//   node scripts/doctor.js <new-binary> [old-binary]
//
// Default old binary: ~/.stepcode/bin/step.orig (the backup build.sh keeps).
//
// Approach: diff the string literals of the old and new embedded bundles.
//   - literals that disappeared are the strings upstream reworded,
//   - literals that appeared are the new wording,
//   - pairing the two sets by similarity turns "1624 keys, 4 missing" into
//     "upstream reworded these 4, here is what they became".
//
// The point is that an update stops meaning "re-translate 1600 strings" and starts
// meaning "fill in the handful upstream actually changed".
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, scanLiterals } from "./lib.js";

const argv = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const newBin = argv[0] || process.env.STEPCODE_BIN || path.join(os.homedir(), ".stepcode", "bin", "step");
const oldBin = argv[1] || path.join(os.homedir(), ".stepcode", "bin", "step.orig");

// --- pull the embedded bundle out of a binary ---------------------------------------
function bundleOf(bin) {
	const data = fs.readFileSync(bin);
	const marker = Buffer.from("\x00/$bunfs/root/step\x00");
	const at = data.indexOf(marker);
	if (at < 0) throw new Error(`could not find /$bunfs/root/step inside ${bin}`);
	const start = at + marker.length;
	const next = data.indexOf(Buffer.from("\x00/$bunfs/"), start);
	const end = next < 0 ? data.length : next;
	return data.slice(start, end).toString("utf8");
}

function versionOf(bin) {
	try {
		return execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 60_000 }).trim();
	} catch {
		return "unknown";
	}
}

/** Every string literal in the bundle, decoded, de-duplicated. */
function literalsOf(src) {
	const spans = scanLiterals(src);
	const out = new Set();
	for (const s of spans) {
		if (s.kind !== "dq" && s.kind !== "sq" && s.kind !== "tpl") continue;
		const raw = src.slice(s.start, s.end);
		const quote = raw[0];
		if (quote !== '"' && quote !== "'" && quote !== "`") continue;
		let text;
		try {
			// Evaluate the literal so escapes (\u2191, \n, ...) become real characters.
			text = eval(raw);
		} catch {
			continue;
		}
		if (typeof text === "string" && text.length > 0 && text.length < 400) out.add(text);
	}
	return out;
}

/** Similarity in [0,1]: shared-word Jaccard, which survives rewording better than edit distance. */
function similarity(a, b) {
	const words = (s) => new Set(s.toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length > 2));
	const wa = words(a);
	const wb = words(b);
	if (wa.size === 0 || wb.size === 0) return 0;
	let shared = 0;
	for (const w of wa) if (wb.has(w)) shared++;
	return shared / (wa.size + wb.size - shared);
}

for (const bin of [newBin, oldBin]) {
	if (!fs.existsSync(bin)) {
		console.error(`binary not found: ${bin}`);
		console.error("usage: node scripts/doctor.js <new-binary> [old-binary]");
		process.exit(1);
	}
}

console.log("== 版本 ==");
console.log(`  旧: ${oldBin}  (${versionOf(oldBin)})`);
console.log(`  新: ${newBin}  (${versionOf(newBin)})`);

const oldSrc = bundleOf(oldBin);
const newSrc = bundleOf(newBin);
const oldSet = literalsOf(oldSrc);
const newSet = literalsOf(newSrc);

const removed = [...oldSet].filter((s) => !newSet.has(s));
const added = [...newSet].filter((s) => !oldSet.has(s));
console.log(`\n== bundle 字符串字面量 ==`);
console.log(`  旧: ${oldSet.size} 个，新: ${newSet.size} 个`);
console.log(`  消失: ${removed.length} 个，新增: ${added.length} 个`);

// --- pair removed with added ---------------------------------------------------------
const pairs = [];
const usedAdded = new Set();
const ranked = removed
	.map((old) => {
		const best = added
			.filter((a) => !usedAdded.has(a))
			.map((a) => ({ a, score: similarity(old, a) }))
			.sort((x, y) => y.score - x.score)[0];
		return best && best.score >= 0.4 ? { old, next: best.a, score: best.score } : { old, next: undefined, score: 0 };
	})
	.sort((x, y) => y.score - x.score);

for (const r of ranked) {
	if (!r.next) continue;
	pairs.push(r);
	usedAdded.add(r.next);
}
const unpairedRemoved = ranked.filter((r) => !r.next).map((r) => r.old);
const unpairedAdded = added.filter((a) => !usedAdded.has(a));

console.log(`\n== 配对结果 ==`);
console.log(`  高置信改写: ${pairs.length}`);
console.log(`  无法配对的消失项: ${unpairedRemoved.length}`);
console.log(`  无法配对的新增项: ${unpairedAdded.length}`);

// --- only the ones we actually translate matter ---------------------------------------
const tables = new Map();
const i18nDir = path.join(ROOT, "i18n");
for (const f of fs.readdirSync(i18nDir).filter((f) => /^zh_\d+\.json$/.test(f)).sort()) {
	for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(i18nDir, f), "utf8")))) tables.set(k, { v, f });
}
for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(i18nDir, "zh_help.json"), "utf8")))) {
	tables.set(k, { v, f: "zh_help.json" });
}

const actionable = pairs.filter((p) => tables.has(p.old));
const alsoGone = unpairedRemoved.filter((s) => tables.has(s));

if (actionable.length === 0 && alsoGone.length === 0) {
	console.log(`\n没有我们翻译过的字符串被改写。`);
	console.log(`如果构建仍然失败，跑 ./build.sh 看缺哪些键，那些是插值/结构变化而不是文案改写。`);
	process.exit(0);
}

if (actionable.length > 0) {
	console.log(`\n--- 上游改写了我们已翻译的 ${actionable.length} 条 ---`);
	for (const p of actionable) {
		console.log(`  旧: ${JSON.stringify(p.old)}`);
		console.log(`  新: ${JSON.stringify(p.next)}   (相似度 ${p.score.toFixed(2)})`);
		console.log(`  原译: ${JSON.stringify(tables.get(p.old).v)}`);
	}
}
if (alsoGone.length > 0) {
	console.log(`\n--- 这些消失了但没找到对应新文案，要人工看 ---`);
	for (const s of alsoGone) console.log(`  ${JSON.stringify(s)}  (原译 ${JSON.stringify(tables.get(s).v)})`);
}

// --- stage migration stubs ------------------------------------------------------------
const migratePath = path.join(i18nDir, "zh_migrate.json");
const existing = fs.existsSync(migratePath) ? JSON.parse(fs.readFileSync(migratePath, "utf8")) : {};
let staged = 0;
for (const p of actionable) {
	const next = p.next;
	if (Object.hasOwn(existing, next)) continue;
	// Pre-fill with the old translation so the reviewer edits rather than writes.
	existing[next] = tables.get(p.old).v;
	staged++;
}
fs.writeFileSync(migratePath, `${JSON.stringify(existing, null, 1)}\n`);
console.log(`\n${path.relative(ROOT, migratePath)}：共 ${Object.keys(existing).length} 条（本次新增 ${staged}，值已预填原译，请按新文案校对）`);

// --- retire the stale keys ------------------------------------------------------------
// A stale key is one the tables still carry but the new bundle no longer emits. Leaving it
// in place keeps the build failing forever, which is exactly the "silently rots" failure
// this tool exists to prevent. Retire it once its translation has a replacement: either
// doctor staged one from a high-confidence pair above, or a human added one by hand to
// zh_migrate.json. Keys with no replacement stay for a human.
const isWord = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(String.fromCharCode(c));
function presentIn(key) {
	if (newSrc.includes(`"${key}"`) || newSrc.includes(`'${key}'`)) return true;
	let pos = -1;
	while ((pos = newSrc.indexOf(key, pos + 1)) !== -1) {
		const before = pos > 0 ? newSrc[pos - 1] : undefined;
		const after = pos + key.length < newSrc.length ? newSrc[pos + key.length] : undefined;
		const afterIsInterp = after === 0x24 && newSrc[pos + key.length + 1] === 0x7b;
		if (isWord(before) || (isWord(after) && !afterIsInterp)) continue;
		return true;
	}
	return false;
}
const migrateKeys = Object.keys(existing);
const taken = new Set();
const byFile = new Map();
for (const [key, info] of tables) {
	if (presentIn(key)) continue;
	// Pair the stale key with the best-matching entry the human (or doctor) put in
	// zh_migrate.json. No similarity threshold: the file is the explicit signal that a
	// replacement exists, so anything sharing a word is enough to retire the old key.
	let best;
	let bestScore = 0;
	for (const candidate of migrateKeys) {
		if (taken.has(candidate)) continue;
		const score = similarity(key, candidate);
		if (score > bestScore) {
			best = candidate;
			bestScore = score;
		}
	}
	if (best === undefined) continue;
	taken.add(best);
	if (!byFile.has(info.f)) byFile.set(info.f, []);
	byFile.get(info.f).push(key);
}
if (byFile.size === 0) {
	console.log("\n没有可退休的失效键（要么没有失效键，要么译文还没有对应新键）。");
} else {
	for (const [file, keys] of byFile) {
		const full = path.join(i18nDir, file);
		const table = JSON.parse(fs.readFileSync(full, "utf8"));
		let removed = 0;
		for (const k of keys) {
			if (Object.hasOwn(table, k)) {
				delete table[k];
				removed++;
			}
		}
		fs.writeFileSync(full, `${JSON.stringify(table, null, 1)}\n`);
		console.log(`已从 ${file} 退休 ${removed} 个失效键（译文已在 zh_migrate.json 里有新键）`);
	}
}
