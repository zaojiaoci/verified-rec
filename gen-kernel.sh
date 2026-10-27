#!/usr/bin/env bash
# gen-kernel.sh — 从源 wasm 再生 JS 内核（可复现构建，见 PROVENANCE.md）。
# 用法：./gen-kernel.sh 0.1
# 依赖：wasm2js（binaryen 120，其他版本产物可能字节不同）
set -euo pipefail
cd "$(dirname "$0")"

VER="${1:?用法：./gen-kernel.sh <版本号>，如 0.1}"
SRC="kernel/sim-${VER}.wasm"
OUT="kernel/kernel-asm-${VER}.js"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

[ -f "$SRC" ] || { echo "没有 $SRC" >&2; exit 1; }
command -v wasm2js >/dev/null || { echo "wasm2js 不在 PATH（需要 binaryen 120）" >&2; exit 1; }

wasm2js --pedantic --enable-bulk-memory --enable-sign-ext \
        --enable-mutable-globals --enable-nontrapping-float-to-int \
        "$SRC" -o "$TMP"

# env 只需 setTempRet0 一族（i64 拆装的高半暂存）；本项目 i64 全是小整数，
# 高半恒 0 ⇒ 空实现即保真（与游戏 web/build.py 的入库替换同款）。
python3 - "$TMP" "$OUT" <<'PY'
import sys
src = open(sys.argv[1]).read()
needle = "import * as env from 'env';"
assert needle in src, "wasm2js 产物里找不到 env import——工具链版本不对？"
src = src.replace(needle, "const env = new Proxy({}, { get: () => () => 0 });")
open(sys.argv[2], 'w').write(src)
PY

echo "== 再生完成："
sha256sum "$SRC" "$OUT"
echo "== 把上面两个哈希登记进 PROVENANCE.md 的版本表。"
