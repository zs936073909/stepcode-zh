#!/usr/bin/env node
// Key-context fingerprinting, used by scripts/doctor.js to recover from upstream copy edits.
//
// When a key matches during patching, we record the text around it with the key itself
// masked out. After `step update --self` rewrites a label, the surrounding code is far more
// stable than the label, so doctor can wildcard-search the new bundle with that context
// and read back whatever text now sits in the slot.
//
// Recording is best-effort: it costs memory, so it is skipped for the very large pass-1
// table unless explicitly enabled, and doctor always falls back to the diff-based pairing
// when no fingerprint exists.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib.js";

const KEYMAP_PATH = path.join(ROOT, "build", "keymap.json");

/** Record the context around a matched key. */
export function recordKey(map, key, src, matchStart, matchEnd, pass) {
	const entries = map.get(key);
	if (entries === undefined) {
		map.set(key, [{ pass, before: src.slice(Math.max(0, matchStart - 110), matchStart), after: src.slice(matchEnd, matchEnd + 70) }]);
		return;
	}
	if (entries.length < 3) {
		entries.push({ pass, before: src.slice(Math.max(0, matchStart - 110), matchStart), after: src.slice(matchEnd, matchEnd + 70) });
	}
}

export function loadKeymap() {
	if (!fs.existsSync(KEYMAP_PATH)) return new Map();
	try {
		const raw = JSON.parse(fs.readFileSync(KEYMAP_PATH, "utf8"));
		return new Map(Object.entries(raw));
	} catch {
		return new Map();
	}
}

export function saveKeymap(map) {
	const obj = Object.fromEntries(map);
	fs.mkdirSync(path.dirname(KEYMAP_PATH), { recursive: true });
	fs.writeFileSync(KEYMAP_PATH, JSON.stringify(obj));
}

/**
 * Search `haystack` for a recorded context and return whatever now sits in the masked
 * slot. Returns undefined when the context itself no longer matches.
 */
export function recoverFromContext(entry, haystack) {
	const { before, after } = entry;
	if (before.length === 0 && after.length === 0) return undefined;
	const toPattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
	const pattern = `${toPattern(before)}([\\s\\S]*?)${toPattern(after)}`;
	let re;
	try {
		re = new RegExp(pattern, "u");
	} catch {
		return undefined;
	}
	const m = haystack.match(re);
	if (!m) return undefined;
	const candidate = m[1];
	// A slot that swallowed a huge chunk means the context matched by accident.
	if (candidate.length > 400 || candidate.includes("\n\n")) return undefined;
	return candidate;
}

export { KEYMAP_PATH };
