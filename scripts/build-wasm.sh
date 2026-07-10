#!/usr/bin/env bash
# Builds the four per-entry wasm artifacts into wasm/.
#
# The gdelta crates are pure Rust. The zstd crates compile libzstd's C source
# and therefore need a clang that can target wasm32-unknown-unknown (Apple
# clang cannot). The nix devshell (`nix develop`) provides and wires up
# everything; outside it, set CC_wasm32_unknown_unknown etc. yourself.
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET=wasm32-unknown-unknown
OUT=wasm

# Start clean before any fallible step (compiler check, cargo build): a
# build that fails early must not leave a removed backend's stale artifact
# sitting in the publishable output directory. Fail closed: -f tolerates
# absent glob targets, but a real deletion failure must stop the build.
mkdir -p "$OUT"
rm -f "$OUT"/*.wasm "$OUT"/.*.tmp.wasm

if ! "${CC_wasm32_unknown_unknown:-clang}" --print-targets 2>/dev/null | grep -q wasm32; then
  echo "error: no wasm32-capable C compiler found for libzstd." >&2
  echo "       Enter the dev shell first: nix develop" >&2
  exit 1
fi

cargo build --release --target "$TARGET" \
  -p gdelta-encode-wasm \
  -p gdelta-decode-wasm \
  -p zstd-compress-wasm \
  -p zstd-decompress-wasm

# artifact name → intended export surface. Anything else (e.g. zstd-sys'
# no_mangle shim helpers) is stripped from the export section; the export
# surface is asserted by tests/wasm-surface.test.ts.
COMMON="memory walloc wfree"
declare -A artifacts=(
  [gdelta_encode_wasm]=gdelta_encode
  [gdelta_decode_wasm]=gdelta_decode
  [zstd_compress_wasm]=zstd_compress
  [zstd_decompress_wasm]=zstd_decompress
)
declare -A exports=(
  [gdelta_encode]="$COMMON gdelta_encode gdelta_result_ptr gdelta_result_len gdelta_result_free"
  [gdelta_decode]="$COMMON gdelta_decoder_new gdelta_decoder_push gdelta_decoder_read gdelta_decoder_finish gdelta_decoder_free"
  [zstd_compress]="$COMMON zstd_comp_new zstd_comp_transform zstd_comp_end zstd_comp_free"
  [zstd_decompress]="$COMMON zstd_decomp_new zstd_decomp_transform zstd_decomp_done zstd_decomp_free"
)

if ! command -v wasm-opt >/dev/null 2>&1; then
  echo "warning: wasm-opt not found; artifacts will be larger than the devshell build" >&2
fi

# Stage through a temp file so a failed step never leaves a half-processed
# artifact in the published wasm/ directory.
for src in "${!artifacts[@]}"; do
  name="${artifacts[$src]}"
  dst="$OUT/$name.wasm"
  tmp="$OUT/.$name.tmp.wasm"
  cp "target/$TARGET/release/$src.wasm" "$tmp"
  # shellcheck disable=SC2086
  node scripts/strip-wasm-exports.mjs "$tmp" ${exports[$name]}
  if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int \
      --enable-sign-ext --enable-mutable-globals "$tmp" -o "$tmp"
  fi
  mv -f "$tmp" "$dst"
  chmod 644 "$dst" # data asset, not an executable
done

ls -la "$OUT"/*.wasm
