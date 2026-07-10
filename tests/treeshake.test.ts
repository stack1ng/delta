/**
 * Real-bundler asset budgets (rolldown, browser platform, new URL → asset).
 *
 * The assertion targets what the emitted chunk actually REFERENCES — that
 * is what a runtime will ever fetch. (Rolldown ≤1.1 additionally copies
 * unreferenced .wasm assets from tree-shaken modules into the output at
 * scan time; those are dead files, never loaded, so they are not counted
 * here — the leaf case additionally pins the emitted-asset set exactly.)
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
const built =
  existsSync(join(dist, "index.js")) && existsSync(join(root, "wasm", "gdelta_decode.wasm"));

const ARTIFACTS = ["gdelta_decode", "gdelta_encode", "zstd_compress", "zstd_decompress"] as const;

interface BundleResult {
  /** Artifact stems the generated code references (what a runtime loads). */
  referenced: string[];
  /** Artifact stems emitted as output assets. */
  emitted: string[];
}

async function bundle(entrySource: string): Promise<BundleResult> {
  const { rolldown } = await import("rolldown");
  const scratch = mkdtempSync(join(tmpdir(), "delta-treeshake-"));
  try {
    const entry = join(scratch, "entry.mjs");
    writeFileSync(entry, entrySource);
    const build = await rolldown({
      input: entry,
      platform: "browser",
      experimental: { resolveNewUrlToAsset: true },
      logLevel: "silent",
    });
    const { output } = await build.generate({ format: "esm" });
    await build.close();

    const code = output
      .filter((item) => item.type === "chunk")
      .map((item) => item.code)
      .join("\n");
    const referenced = ARTIFACTS.filter((name) => code.includes(name));
    const emitted = ARTIFACTS.filter((name) =>
      output.some((item) => item.type === "asset" && item.fileName.includes(name)),
    );
    return { referenced: [...referenced], emitted: [...emitted] };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe.skipIf(!built)("bundler asset budget (rolldown)", () => {
  it("leaf decode import references and emits exactly the decode wasm", async () => {
    const result = await bundle(`
      import { decodeDelta } from "${join(dist, "gdelta", "decode.js")}";
      console.log(typeof decodeDelta);
    `);
    expect(result.referenced).toEqual(["gdelta_decode"]);
    expect(result.emitted).toEqual(["gdelta_decode"]);
  });

  it("root import of one function loads only that entry's wasm", async () => {
    const result = await bundle(`
      import { decodeDelta } from "${join(dist, "index.js")}";
      console.log(typeof decodeDelta);
    `);
    expect(result.referenced).toEqual(["gdelta_decode"]);
  });

  it("pipeline decode leaf references AND emits only the decode side", async () => {
    const result = await bundle(`
      import { decodeFramed } from "${join(dist, "pipeline", "decode.js")}";
      console.log(typeof decodeFramed);
    `);
    expect(result.referenced).toEqual(["gdelta_decode", "zstd_decompress"]);
    expect(result.emitted).toEqual(["gdelta_decode", "zstd_decompress"]);
  });

  it("pipeline encode leaf references AND emits only the encode side", async () => {
    const result = await bundle(`
      import { encodeFramed } from "${join(dist, "pipeline", "encode.js")}";
      console.log(typeof encodeFramed);
    `);
    expect(result.referenced).toEqual(["gdelta_encode", "zstd_compress"]);
    expect(result.emitted).toEqual(["gdelta_encode", "zstd_compress"]);
  });

  it("combined pipeline decode-only import still drops encode-side references", async () => {
    const result = await bundle(`
      import { decodeFramed } from "${join(dist, "pipeline", "index.js")}";
      console.log(typeof decodeFramed);
    `);
    expect(result.referenced).toEqual(["gdelta_decode", "zstd_decompress"]);
  });

  it("full pipeline references all four (and no fused artifact)", async () => {
    const result = await bundle(`
      import { encodeFramed, decodeFramed } from "${join(dist, "pipeline", "index.js")}";
      console.log(typeof encodeFramed, typeof decodeFramed);
    `);
    expect(result.referenced).toEqual([...ARTIFACTS]);
  });
});
