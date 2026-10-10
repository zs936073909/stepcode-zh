#!/usr/bin/env node
// Self-test: exercise the patch pipeline on a synthetic bundle, without needing a real
// `step` binary. Runs in CI.
//
//   node scripts/selftest.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, interpolations, padTo, repad, validateValue } from "./lib.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stepcode-i18n-selftest-"));
const results = [];
function test(name, fn) {
	try {
		fn();
		results.push({ name, ok: true });
		console.log(`  PASS  ${name}`);
	} catch (error) {
		results.push({ name, ok: false, error: String(error).slice(0, 300) });
		console.log(`  FAIL  ${name}\n        ${String(error).slice(0, 300)}`);
	}
}

// A miniature stand-in for the real bundle: the same shapes that matter.
const SYNTHETIC = [
	"#!/usr/bin/env node",
	'const a = "Open settings menu";',
	"const b = 'Open settings menu';",
	'const c = `Quit ${APP_NAME}`;',
	'const d = "Ask";',
	'const opts = ["Cancel", "Install"];',
	'function pick(x) { return x === "Cancel"; }',
	'const tpl = `Mode: ${label} done`;',
	'const nested = { value: "on", label: "on" };',
	'const keep = "No file-list backend available: fd was missing";',
	"module.exports = { a, b, c, d, opts, pick, tpl, nested, keep };",
	"",
].join("\n");

const TABLES = {
	"zh_1.json": {
		"Open settings menu": "打开设置菜单",
		Cancel: "取消",
		Install: "安装",
		"No file-list backend available: fd was missing": "没有可用的文件列表后端",
	},
	"zh_help.json": {
		"`Quit ${APP_NAME}`": "`退出${APP_NAME}`",
		"Mode: ${label} done": "模式 ${label}",
		'{ value: "on", label: "on" }': '{ value: "on", label: "开" }',
	},
};

// Run the real scripts against the synthetic bundle.
const build = path.join(tmp, "build");
fs.mkdirSync(build, { recursive: true });
fs.writeFileSync(path.join(build, "step_bundle.js"), SYNTHETIC);
const i18nDir = path.join(tmp, "i18n");
fs.mkdirSync(i18nDir, { recursive: true });
for (const [name, table] of Object.entries(TABLES)) {
	fs.writeFileSync(path.join(i18nDir, name), JSON.stringify(table, null, 1));
}
// Mirror the repo layout so the scripts resolve their paths.
const scripts = path.join(tmp, "scripts");
fs.mkdirSync(scripts, { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, "scripts"))) {
	if (f.endsWith(".js") || f.endsWith(".ts")) fs.copyFileSync(path.join(ROOT, "scripts", f), path.join(scripts, f));
}
fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }));

function runScript(script, extraArgs = []) {
	return execFileSync(process.execPath, [path.join(scripts, script), ...extraArgs], {
		cwd: tmp,
		encoding: "utf8",
		timeout: 120_000,
		env: { ...process.env, STEPCODE_I18N_ROOT: tmp },
	});
}

// The scripts resolve ROOT from their own location, so copy the tree instead.
const ROOT_MARKER = path.join(scripts, "lib.js");

test("synthetic bundle is valid JavaScript", () => {
	execFileSync(process.execPath, ["--check", path.join(build, "step_bundle.js")]);
});

test("pass 1 replaces BOTH quote styles (regression: coverage bug)", () => {
	runScript("patch.js", [path.join(build, "step_bundle.js"), "-o", path.join(build, "p1.js")]);
	const out = fs.readFileSync(path.join(build, "p1.js"), "utf8");
	assert.ok(out.includes('"打开设置菜单"'), `double-quoted form not translated:\n${out}`);
	assert.ok(out.includes("'打开设置菜单'"), `single-quoted form not translated:\n${out}`);
	// Pass 1 deliberately leaves the bundle shorter; the length is restored once, at the
	// end, by pass 2. What must hold here is that it never grows.
	assert.ok(
		Buffer.byteLength(out) <= Buffer.byteLength(SYNTHETIC),
		`pass 1 grew the bundle: ${Buffer.byteLength(out)} > ${Buffer.byteLength(SYNTHETIC)}`,
	);
});

test("pass 1 keeps both sides of a comparison consistent", () => {
	const out = fs.readFileSync(path.join(build, "p1.js"), "utf8");
	assert.ok(out.includes('["取消", "安装"]'), `option array not translated: ${out}`);
	assert.ok(out.includes('x === "取消"'), `comparison not translated: ${out}`);
});

test("pass 1 fails loudly on a missing key instead of half-translating", () => {
	const bad = path.join(tmp, "bad");
	fs.mkdirSync(bad, { recursive: true });
	fs.writeFileSync(path.join(bad, "step_bundle.js"), 'const x = "Some string nobody translated";\n');
	let failed = false;
	try {
		execFileSync(process.execPath, [path.join(scripts, "patch.js"), path.join(bad, "step_bundle.js"), "-o", path.join(bad, "out.js")], {
			cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
		});
	} catch {
		failed = true;
	}
	assert.ok(failed, "patch.js should exit non-zero when a key no longer matches");
});

test("pass 2 rejects a value that invents an interpolation", () => {
	const errs = validateValue("Plain label", "坏值 ${process.exit(1)}", "tpl");
	assert.ok(
		errs.some((e) => e.includes("new identifier") || e.includes("more ${...}")),
		`expected an interpolation error, got: ${errs}`,
	);
});

test("pass 2 rejects a value that would close the enclosing literal", () => {
	assert.ok(validateValue("A label", '他说"你好"', "dq").some((e) => e.includes("double quote")));
	assert.ok(validateValue("A label", "it's fine", "sq").some((e) => e.includes("single quote")));
	assert.ok(validateValue("A label", "a `backtick`", "tpl").some((e) => e.includes("backtick")));
});

test("pass 2 rejects backslashes and control characters", () => {
	assert.ok(validateValue("A label", "\\q", "dq").length > 0, "an invalid escape must be rejected");
	assert.equal(validateValue("A label", "\\u2191", "dq").length, 0, "a valid escape must be allowed");
	assert.ok(validateValue("A label", "line\nbreak", "dq").length > 0);
});

test("interpolation extraction handles nested braces", () => {
	assert.deepEqual(interpolations("a ${f({x: 1})} b ${y}"), ["${f({x: 1})}", "${y}"]);
	assert.deepEqual(interpolations("${a ? \"}\" : \"{\"}"), ['${a ? "}" : "{"}']);
});

test("padding works for every delta, including 1 and 2 bytes", () => {
	for (const delta of [0, 1, 2, 3, 12, 5000]) {
		const base = Buffer.from("const x = 1;\n");
		const padded = padTo(base, base.length + delta);
		assert.equal(padded.length, base.length + delta, `padTo(${delta})`);
		if (delta > 0) {
			const shrunk = repad(padded, base.length);
			assert.equal(shrunk.length, base.length, `repad after padTo(${delta})`);
		}
	}
	assert.throws(() => padTo(Buffer.from("abc"), 2), /LONGER/);
});

test("pass 2 preserves ${...} and backtick counts", () => {
	runScript("patch_help.js", [path.join(build, "p1.js"), "-o", path.join(build, "p2.js")]);
	const out = fs.readFileSync(path.join(build, "p2.js"), "utf8");
	const count = (s, re) => (s.match(re) ?? []).length;
	assert.equal(count(out, /\$\{/g), count(SYNTHETIC, /\$\{/g), "${ count changed");
	assert.equal(count(out, /`/g), count(SYNTHETIC, /`/g), "backtick count changed");
	assert.ok(out.includes("`退出${APP_NAME}`"), "template-literal key not translated");
	assert.ok(out.includes('label: "开"'), "label-only key not translated");
	assert.ok(out.includes('value: "on"'), "machine-parsed value must stay English");
	// The final artifact must be byte-for-byte the original length.
	assert.equal(
		Buffer.byteLength(out),
		Buffer.byteLength(fs.readFileSync(path.join(build, "step_bundle.js"))),
		"pass 2 must restore the exact byte length",
	);
});

test("audit allows a documented consistent case and blocks a new one", () => {
	const allowPath = path.join(i18nDir, "audit-allowlist.json");
	fs.writeFileSync(allowPath, JSON.stringify({ Cancel: "select option array and the `===` check are replaced together" }, null, 1));
	const ok = execFileSync(process.execPath, [path.join(scripts, "audit.js"), path.join(build, "step_bundle.js")], {
		cwd: tmp, encoding: "utf8", timeout: 60_000,
	});
	assert.ok(ok.includes("audit passed"), `expected a pass:\n${ok}`);

	fs.writeFileSync(allowPath, JSON.stringify({}, null, 1));
	let failed = false;
	try {
		execFileSync(process.execPath, [path.join(scripts, "audit.js"), path.join(build, "step_bundle.js")], {
			cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
		});
	} catch {
		failed = true;
	}
	assert.ok(failed, "audit should fail on an undocumented risky key");
});

test("the real translation tables validate cleanly", () => {
	// Every value in the shipped tables must pass validation in a template-literal
	// context, which is the strictest one.
	const dir = path.join(ROOT, "i18n");
	for (const f of fs.readdirSync(dir).filter((f) => /^zh_.*\.json$/.test(f))) {
		const table = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
		for (const [k, v] of Object.entries(table)) {
			// Multi-line keys are code snippets (for example a whole switch block), not
			// display strings; they are covered by the ${}/identifier rules and by the
			// post-patch `node --check` instead of the display-value rules.
			if (k.includes("\n") || v.includes("\n")) continue;
			const errs = validateValue(k, v, "tpl").filter((e) => !e.includes("backtick"));
			assert.equal(errs.length, 0, `${f}: ${JSON.stringify(k)} -> ${errs.join("; ")}`);
		}
	}
});

fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
	console.error(`\n${failed.length} self-test(s) failed`);
	process.exit(1);
}
console.log(`\nall ${results.length} self-tests passed`);
