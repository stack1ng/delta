/**
 * Runtime and packaging gates that plain vitest-in-Node cannot see:
 *
 * - Bun (≤1.3) lacks `WritableStreamDefaultController.signal`; every
 *   pump-backed operation must still work there (the in-flight-abort
 *   shortcut is the only thing feature-gated away).
 * - The prepack gate must fail on missing export targets, empty or corrupt
 *   wasm, and pass on an intact build — derived from the export map, not a
 *   hard-coded list.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const built = existsSync(join(root, "dist", "index.js"));
const bunBin = (() => {
  try {
    return execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
})();

describe.skipIf(!built || bunBin === undefined)("bun runtime", () => {
  it("runs pump-backed compress/decompress and framed round trips", () => {
    const script = `
      const { compress } = await import("${join(root, "dist", "zstd", "compress.js")}");
      const { decompress } = await import("${join(root, "dist", "zstd", "decompress.js")}");
      const { encodeFramedBytes, decodeFramedBytes } = await import(
        "${join(root, "dist", "pipeline", "index.js")}"
      );
      const input = new Uint8Array(4096).map((_, i) => i % 251);
      const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
      const out = await decompress(await compress(input), { maxOutputBytes: 8192 });
      if (!equal(out, input)) throw new Error("zstd byte mismatch");
      const old = input.slice(0, 2048);
      const framed = await encodeFramedBytes(old, input);
      const restored = await decodeFramedBytes(old, framed);
      if (!equal(restored, input)) throw new Error("framed byte mismatch");
      console.log("BUN_SMOKE_OK");
    `;
    const scratch = mkdtempSync(join(tmpdir(), "delta-bun-"));
    try {
      const file = join(scratch, "smoke.mjs");
      writeFileSync(file, script);
      const result = spawnSync(bunBin as string, [file], { encoding: "utf8", timeout: 30_000 });
      expect(result.stdout).toContain("BUN_SMOKE_OK");
      expect(result.status).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

function gateResult(scratch: string): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [join(scratch, "scripts", "check-artifacts.mjs")], {
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr };
}

describe.skipIf(!built)("prepack gate", () => {
  function scratchTree(): string {
    const scratch = mkdtempSync(join(tmpdir(), "delta-gate-"));
    for (const item of ["dist", "wasm", "scripts", "package.json"]) {
      cpSync(join(root, item), join(scratch, item), { recursive: true });
    }
    return scratch;
  }

  it("passes on an intact build and fails on every corruption the evaluator probed", () => {
    const scratch = scratchTree();
    try {
      expect(gateResult(scratch).status).toBe(0);

      // Missing export target (a round-three drift case: pipeline leaves).
      rmSync(join(scratch, "dist", "pipeline", "encode.js"));
      const missing = gateResult(scratch);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("pipeline/encode.js");
      cpSync(
        join(root, "dist", "pipeline", "encode.js"),
        join(scratch, "dist", "pipeline", "encode.js"),
      );

      // Empty wasm.
      truncateSync(join(scratch, "wasm", "gdelta_decode.wasm"), 0);
      const empty = gateResult(scratch);
      expect(empty.status).toBe(1);
      expect(empty.stderr).toContain("gdelta_decode.wasm");

      // Corrupt (non-wasm) bytes.
      writeFileSync(join(scratch, "wasm", "gdelta_decode.wasm"), "not wasm at all");
      const corrupt = gateResult(scratch);
      expect(corrupt.status).toBe(1);
      expect(corrupt.stderr).toContain("not valid WebAssembly");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
