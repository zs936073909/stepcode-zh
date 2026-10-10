#!/usr/bin/env node
// Smoke test: run the freshly built binary and check it still behaves.
//
//   node scripts/verify.js [path-to-original] [path-to-patched]
//
// A translation can be syntactically perfect and still change behaviour — for example by
// replacing a string the program uses as an object key or a persisted config value. Those
// only surface at run time, so the build ends here rather than at `node --check`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./lib.js";

const args = process.argv.slice(2);
const orig = args[0] || process.env.STEPCODE_BIN || path.join(os.homedir(), ".stepcode", "bin", "step.orig");
const patched = args[1] || path.join(ROOT, "build", "step.zh");

function run(bin, argv) {
	try {
		const stdout = execFileSync(bin, argv, { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
		return { code: 0, stdout };
	} catch (error) {
		return { code: error.status ?? 1, stdout: `${error.stdout ?? ""}${error.stderr ?? ""}` };
	}
}

// Stage the patched binary next to the asset directories it resolves at run time
// (`theme/`, `docs/`, ... are looked up relative to the executable).
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "stepcode-zh-verify-"));
const patchedBin = path.join(stage, "step");
fs.copyFileSync(patched, patchedBin);
fs.chmodSync(patchedBin, 0o755);
const origDir = path.dirname(path.resolve(orig));
for (const asset of ["theme", "docs", "examples", "export-html"]) {
	const src = path.join(origDir, asset);
	if (fs.existsSync(src)) fs.cpSync(src, path.join(stage, asset), { recursive: true });
}

const checks = [];
function check(name, ok, detail = "") {
	checks.push({ name, ok, detail });
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log(`original: ${orig}`);
console.log(`patched : ${patched} (staged at ${patchedBin})`);

// --- version must be identical ------------------------------------------------------
const v1 = run(orig, ["--version"]);
const v2 = run(patchedBin, ["--version"]);
check("patched binary runs", v2.code === 0, `exit ${v2.code}`);
check(
	"version unchanged",
	v1.stdout.trim() === v2.stdout.trim() && v2.stdout.trim().length > 0,
	`${v1.stdout.trim()} vs ${v2.stdout.trim()}`,
);

// --- exit codes must match on the surfaces we translated ----------------------------
const probes = [
	["--help", ["用法"]],
	["install --help", ["用法"]],
	["auth --help", ["用法"]],
	["list", []],
];
for (const [argv, markers] of probes) {
	const a = run(orig, argv.split(" "));
	const b = run(patchedBin, argv.split(" "));
	check(`${argv}: exit code matches`, a.code === b.code, `${a.code} vs ${b.code}`);
	if (markers.length > 0) {
		const missing = markers.filter((m) => !b.stdout.includes(m));
		check(`${argv}: Chinese markers present`, missing.length === 0, missing.length ? `missing ${missing.join(",")}` : "ok");
	}
}

// --- error paths still report (translated) instead of crashing ----------------------
const bad = run(patchedBin, ["--definitely-not-a-flag"]);
check(
	"unknown flag still reports an error",
	bad.code !== 0 && bad.stdout.length > 0,
	bad.stdout.trim().split("\n")[0]?.slice(0, 80),
);

// --- the built bundle must parse ----------------------------------------------------
try {
	const bundle = fs.readFileSync(path.join(ROOT, "build", "step_bundle.zh2.js"));
	const tmp = path.join(ROOT, "build", "_verify.js");
	fs.writeFileSync(tmp, bundle.slice(Buffer.byteLength("#!/usr/bin/env node\n")));
	execFileSync(process.execPath, ["--check", tmp], { timeout: 120_000 });
	fs.rmSync(tmp, { force: true });
	check("patched bundle parses as JavaScript", true);
} catch (error) {
	check("patched bundle parses as JavaScript", false, String(error).slice(0, 120));
}

fs.rmSync(stage, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
if (failed.length > 0) {
	console.error(`\n${failed.length} smoke check(s) failed`);
	process.exit(1);
}
console.log(`\nall ${checks.length} smoke checks passed`);
