/**
 * Every artifact must expose exactly its intended ABI: the entry's exports
 * plus the shared memory/alloc trio, and nothing else (no zstd-sys shim
 * symbols, no linker globals). Guards the strip step in build-wasm.sh.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const wasmDir = resolve(import.meta.dirname, "..", "wasm");

const COMMON = ["memory", "walloc", "wfree"];
const surfaces: Array<[string, string[]]> = [
  [
    "gdelta_encode.wasm",
    ["gdelta_encode", "gdelta_result_ptr", "gdelta_result_len", "gdelta_result_free"],
  ],
  [
    "gdelta_decode.wasm",
    [
      "gdelta_decoder_new",
      "gdelta_decoder_push",
      "gdelta_decoder_read",
      "gdelta_decoder_finish",
      "gdelta_decoder_free",
    ],
  ],
  [
    "zstd_compress.wasm",
    ["zstd_comp_new", "zstd_comp_transform", "zstd_comp_end", "zstd_comp_free"],
  ],
  [
    "zstd_decompress.wasm",
    ["zstd_decomp_new", "zstd_decomp_transform", "zstd_decomp_done", "zstd_decomp_free"],
  ],
];

// Skip only when nothing was built at all; a partially built wasm/ dir must
// fail loudly rather than silently skipping the gate.
const anyBuilt = surfaces.some(([artifact]) => existsSync(join(wasmDir, artifact)));

describe.skipIf(!anyBuilt)("wasm export surface", () => {
  for (const [artifact, own] of surfaces) {
    it(`${artifact} exports exactly its ABI`, async () => {
      const module = await WebAssembly.compile(await readFile(join(wasmDir, artifact)));
      const names = WebAssembly.Module.exports(module)
        .map((entry) => entry.name)
        .toSorted();
      expect(names).toEqual([...COMMON, ...own].toSorted());
    });
  }
});

describe.skipIf(!anyBuilt)("allocator zero-size contract", () => {
  for (const [artifact] of surfaces) {
    it(`${artifact}: walloc(0) returns 0 and wfree(0, 0) is a no-op`, async () => {
      const module = await WebAssembly.compile(await readFile(join(wasmDir, artifact)));
      const { exports } = (await WebAssembly.instantiate(module, {})) as unknown as {
        exports: { walloc(len: number): number; wfree(ptr: number, len: number): void };
      };
      expect(exports.walloc(0)).toBe(0);
      expect(() => exports.wfree(0, 0)).not.toThrow();
      expect(() => exports.wfree(0, 16)).not.toThrow();
      // Non-zero allocation still works and frees cleanly.
      const ptr = exports.walloc(64);
      expect(ptr).not.toBe(0);
      expect(() => exports.wfree(ptr, 64)).not.toThrow();
    });
  }
});
