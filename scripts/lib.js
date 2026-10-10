'use strict';
// Shared helpers for the StepCode i18n toolchain.
//
// Design notes
// ------------
// * Pass 1 (patch.js) replaces quoted string literals and re-escapes the value, so it is
//   safe by construction.
// * Pass 2 (patch_help.js) inserts values RAW into the bundle, so every value is validated
//   against the literal it lands in (see validateValue). The hard invariants are:
//     - no backslash, no newline, no control characters
//     - the value may not have more ${...} than the key, and every identifier referenced
//       inside those ${...} must already be referenced by the key. A translation may keep
//       an interpolation and translate text inside it (`${bold("Usage:")}` ->
//       `${bold("用法：")}`), but it may not reach for new code.
//     - the value may not contain the quote character that terminates the enclosing literal
//   After patching we also assert that the bundle's total ${...} and backtick counts are
//   unchanged, which makes code injection through a translation table impossible.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// ---------------------------------------------------------------------------
// JS scanner: returns the spans of every string / template / comment / regex.
// Used to know which literal a matched substring lives in.
// ---------------------------------------------------------------------------
export function scanLiterals(src) {
	const spans = [];
	let i = 0;
	const n = src.length;
	const regexPrev = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '*', '%', '<', '>', '~', '^', '\n', '']);
	const regexKw = /(?:^|[^A-Za-z0-9_$])(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/;
	const push = (kind, start, end) => {
		if (end > start) spans.push({ kind, start, end });
	};

	while (i < n) {
		const c = src[i];
		if (c === '/' && src[i + 1] === '/') {
			const s = i;
			while (i < n && src[i] !== '\n') i++;
			push('line-comment', s, i);
			continue;
		}
		if (c === '/' && src[i + 1] === '*') {
			const s = i;
			i += 2;
			while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
			i = Math.min(n, i + 2);
			push('block-comment', s, i);
			continue;
		}
		if (c === '"' || c === "'") {
			const q = c;
			const s = i;
			i++;
			while (i < n) {
				if (src[i] === '\\') {
					i += 2;
					continue;
				}
				if (src[i] === q) {
					i++;
					break;
				}
				if (src[i] === '\n') break; // unterminated
				i++;
			}
			push(q === '"' ? 'dq' : 'sq', s, i);
			continue;
		}
		if (c === '`') {
			const s = i;
			i++;
			while (i < n) {
				if (src[i] === '\\') {
					i += 2;
					continue;
				}
				if (src[i] === '`') {
					i++;
					break;
				}
				if (src[i] === '$' && src[i + 1] === '{') {
					i += 2;
					let braces = 1;
					while (i < n && braces > 0) {
						if (src[i] === '{') braces++;
						else if (src[i] === '}') braces--;
						else if (src[i] === '`') {
							// nested template: skip it wholesale
							i++;
							let d = 1;
							while (i < n && d > 0) {
								if (src[i] === '\\') {
									i += 2;
									continue;
								}
								if (src[i] === '`') d--;
								if (d > 0) i++;
							}
							i++;
							continue;
						}
						i++;
					}
					continue;
				}
				i++;
			}
			push('tpl', s, i);
			continue;
		}
		if (c === '/') {
			let j = i - 1;
			while (j >= 0 && /\s/.test(src[j])) j--;
			const prev = j >= 0 ? src[j] : '\n';
			if (regexPrev.has(prev) || regexKw.test(src.slice(Math.max(0, j - 10), j + 1))) {
				const s = i;
				i++;
				let inClass = false;
				while (i < n) {
					if (src[i] === '\\') {
						i += 2;
						continue;
					}
					if (src[i] === '\n') break;
					if (src[i] === '[') inClass = true;
					else if (src[i] === ']') inClass = false;
					else if (src[i] === '/' && !inClass) {
						i++;
						break;
					}
					i++;
				}
				while (i < n && /[a-z]/.test(src[i])) i++;
				push('regex', s, i);
				continue;
			}
			i++;
			continue;
		}
		i++;
	}
	return spans;
}

/** Which literal (if any) contains byte offset `pos`? */
export function enclosingKind(spans, pos) {
	let lo = 0;
	let hi = spans.length - 1;
	let res = 'code';
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (spans[mid].start <= pos) {
			if (pos < spans[mid].end) res = spans[mid].kind;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return res;
}

// ---------------------------------------------------------------------------
// ${...} extraction with brace counting (handles nested braces and strings).
// ---------------------------------------------------------------------------
export function interpolations(s) {
	const out = [];
	let i = 0;
	while (i < s.length) {
		if (s[i] === '$' && s[i + 1] === '{') {
			let j = i + 2;
			let depth = 1;
			let quote = null;
			while (j < s.length && depth > 0) {
				const c = s[j];
				if (quote) {
					if (c === '\\') {
						j += 2;
						continue;
					}
					if (c === quote) quote = null;
				} else if (c === '"' || c === "'" || c === '`') quote = c;
				else if (c === '{') depth++;
				else if (c === '}') depth--;
				j++;
			}
			out.push(s.slice(i, j));
			i = j;
		} else i++;
	}
	return out;
}

/**
 * Identifier-like tokens referenced inside a ${...} expression. String literals are
 * stripped first so that object-literal keys (`{ask: "询问"}`) are not mistaken for
 * identifiers — only real references count.
 */
export function identifiersIn(expression) {
	const inner = expression.slice(2, -1).replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
	return [...inner.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]);
}

// ---------------------------------------------------------------------------
// Value validation for the raw-insertion pass.
// ---------------------------------------------------------------------------
export function validateValue(key, value, kind) {
	const errs = [];
	if (typeof value !== 'string' || value.length === 0) errs.push('value must be a non-empty string');
	// Backslashes are only allowed as well-formed JS escapes: the source itself writes
	// some keys as `\u2191`, and a translation has to be able to keep that form.
	for (let i = 0; i < value.length; i++) {
		if (value[i] !== '\\') continue;
		const rest = value.slice(i + 1);
		let len = 0;
		if (/^u\{[0-9a-fA-F]+\}/.test(rest)) len = rest.match(/^u\{[0-9a-fA-F]+\}/)[0].length;
		else if (/^u[0-9a-fA-F]{4}/.test(rest)) len = 6;
		else if (/^x[0-9a-fA-F]{2}/.test(rest)) len = 4;
		else if (/^[nrtbfv0'"\\]/.test(rest)) len = 2;
		if (len === 0) {
			errs.push(`backslash at ${i} is not a valid JS escape`);
			break;
		}
		i += len - 1;
	}
	if (/[\r\n\t]/.test(value)) errs.push('newline/tab is not allowed');
	if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) errs.push('control characters are not allowed');
	const iv = interpolations(value);
	const ik = interpolations(key);
	if (iv.length > ik.length) errs.push('value has more ${...} than the key');
	const keyIds = new Set(ik.flatMap(identifiersIn));
	for (const e of iv) {
		for (const id of identifiersIn(e)) {
			if (!keyIds.has(id)) errs.push(`value references a new identifier ${id} inside an interpolation`);
		}
	}
	if (kind === 'dq' && value.includes('"')) errs.push('value contains a double quote but lands inside a "..." literal');
	if (kind === 'sq' && value.includes("'")) errs.push("value contains a single quote but lands inside a '...' literal");
	if (kind === 'tpl' && value.includes('`')) errs.push('value contains a backtick but lands inside a `...` literal');
	if (kind === 'dq' || kind === 'sq') {
		if (iv.length) errs.push('${} inside a quoted string would be shown literally');
	}
	return errs;
}

// ---------------------------------------------------------------------------
// Length-preserving padding. The bundle must keep its exact byte length so that
// every module offset inside the binary stays valid.
// ---------------------------------------------------------------------------
export function padTo(buf, targetLen) {
	const delta = targetLen - buf.length;
	if (delta < 0) throw new Error(`content is ${-delta} bytes LONGER than the target length`);
	return delta === 0 ? buf : Buffer.concat([buf, Buffer.alloc(delta, 0x20)]);
}

/** Shrink a trailing run of spaces (our pad marker) to reach targetLen. */
export function repad(buf, targetLen) {
	let end = buf.length;
	let i = end;
	while (i > 0 && buf[i - 1] === 0x20) i--;
	if (i === end) throw new Error('no trailing pad to resize');
	if (i < targetLen) throw new Error('not enough pad to shrink');
	return buf.slice(0, targetLen);
}

// ---------------------------------------------------------------------------
export function sha256(buf) {
	return crypto.createHash('sha256').update(buf).digest('hex');
}
export function readJson(p) {
	return JSON.parse(fs.readFileSync(p, 'utf8'));
}
export function writeJson(p, o) {
	fs.writeFileSync(p, `${JSON.stringify(o, null, 1)}\n`);
}
