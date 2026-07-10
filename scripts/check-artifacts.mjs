// Publication gate: refuses to pack a tree whose build outputs are missing.
//
// dist/ and wasm/*.wasm are gitignored build products, so a clean checkout
// would otherwise pack a documentation-only tarball without failing. Wired
// up as `prepack`; run `bun run build` (inside `nix develop`) first.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/gdelta/encode.js",
  "dist/gdelta/decode.js",
  "dist/zstd/compress.js",
  "dist/zstd/decompress.js",
  "dist/pipeline/index.js",
  "wasm/gdelta_encode.wasm",
  "wasm/gdelta_decode.wasm",
  "wasm/zstd_compress.wasm",
  "wasm/zstd_decompress.wasm",
];

const missing = required.filter((path) => !existsSync(resolve(root, path)));
if (missing.length > 0) {
  console.error("refusing to pack: build artifacts are missing:");
  for (const path of missing) {
    console.error(`  ${path}`);
  }
  console.error("run `bun run build` (inside `nix develop`) first.");
  process.exit(1);
}
