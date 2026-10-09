#!/usr/bin/env bash
# One-command build: extract -> patch -> audit -> splice
#
#   ./build.sh [path-to-step-binary]
#
# Env:
#   STEPCODE_BIN   path to the step binary (default: ~/.stepcode/bin/step)
#   INSTALL=1      also copy the result over ~/.stepcode/bin/step (backs up the original)
set -euo pipefail
cd "$(dirname "$0")"

BIN="${1:-${STEPCODE_BIN:-$HOME/.stepcode/bin/step}}"
echo "==> using binary: $BIN"
node scripts/extract.js "$BIN"
node scripts/patch.js
node scripts/patch_help.js
echo "==> safety audit"
node scripts/audit.js || true
node scripts/splice.js "$BIN"
echo "==> syntax check"
tail -n +2 build/step_bundle.zh2.js > build/_check.js
node --check build/_check.js && rm -f build/_check.js
echo "==> done: build/step.zh"

if [[ "${INSTALL:-0}" == "1" ]]; then
  TARGET="$HOME/.stepcode/bin/step"
  if [[ ! -f "$TARGET.orig" ]]; then
    cp -p "$TARGET" "$TARGET.orig"
    echo "==> backup written: $TARGET.orig"
  fi
  cp build/step.zh "$TARGET"
  echo "==> installed: $TARGET"
  echo "    退出并重启 step 后生效（正在运行的会话仍在使用旧二进制）"
fi
