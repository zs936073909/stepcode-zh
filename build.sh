#!/usr/bin/env bash
# One-command build: extract -> patch -> audit -> splice -> verify.
#
#   ./build.sh [path-to-step-binary]
#
# Env:
#   STEPCODE_BIN   path to the step binary (default: ~/.stepcode/bin/step)
#   INSTALL=1      also install the result (backs up the original as step.orig)
#   LENIENT=1      do not fail when a translation key no longer matches
#
# The build fails closed: a missing key, an unverified bundle boundary, a rejected
# translation value, a new audit finding, or a failed smoke check all stop it.
set -euo pipefail
cd "$(dirname "$0")"

BIN="${1:-${STEPCODE_BIN:-$HOME/.stepcode/bin/step}}"
echo "==> using binary: $BIN"
node scripts/extract.js "$BIN"

PATCH_ARGS=()
[[ "${LENIENT:-0}" == "1" ]] && PATCH_ARGS+=(--lenient)

node scripts/patch.js "${PATCH_ARGS[@]}"
node scripts/patch_help.js

echo "==> safety audit"
node scripts/audit.js

echo "==> syntax check"
tail -n +2 build/step_bundle.zh2.js > build/_check.js
node --check build/_check.js && rm -f build/_check.js

node scripts/splice.js "$BIN"

echo "==> smoke test"
if [[ -f "$BIN.orig" ]]; then
	node scripts/verify.js "$BIN.orig" build/step.zh
else
	node scripts/verify.js "$BIN" build/step.zh
fi

echo "==> done: build/step.zh"

if [[ "${INSTALL:-0}" == "1" ]]; then
	TARGET="$HOME/.stepcode/bin/step"
	if [[ ! -f "$TARGET.orig" ]]; then
		cp -p "$TARGET" "$TARGET.orig"
		echo "==> backup written: $TARGET.orig"
	fi
	# Write-then-rename: the running session holds the old inode, and a plain `cp`
	# fails with ETXTBSY.
	cp build/step.zh "$TARGET.new"
	mv -f "$TARGET.new" "$TARGET"
	chmod 755 "$TARGET"
	echo "==> installed: $TARGET"
	echo "    退出并重启 step 后生效（正在运行的会话仍持有旧二进制的 inode）"
fi
