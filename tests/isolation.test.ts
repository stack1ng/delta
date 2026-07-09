/**
 * Entry isolation: importing one entrypoint must never load another entry's
 * wasm. Verified two ways:
 *
 * 1. Statically — walking each dist entry's import graph and collecting every
 *    referenced `.wasm` asset.
 * 2. At runtime — running a decode in a scratch package that contains ONLY
 *    `gdelta_decode.wasm`; if the decode entry touched any other artifact it
 *    would fail on the missing file.
 */

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { decodeDeltaBytes } from "../src/gdelta/decode.js";
import { encodeDeltaBytes } from "../src/gdelta/encode.js";
import { jsonSnapshot, mutateSnapshot } from "./helpers.js";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
const wasmDir = join(root, "wasm");

const built = existsSync(dist) && existsSync(join(wasmDir, "gdelta_decode.wasm"));

/** Collects every .wasm filename reachable from a dist module's import graph. */
function wasmRefsOf(entry: string): Set<string> {
  const seen = new Set<string>();
  const refs = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      queue.push(resolve(dirname(file), match[1] as string));
    }
    for (const match of source.matchAll(/new URL\("([^"]*\.wasm)"/g)) {
      const url = match[1] as string;
      refs.add(url.slice(url.lastIndexOf("/") + 1));
    }
  }
  return refs;
}

describe.skipIf(!built)("entry isolation (static import graph)", () => {
  const expectations: Array<[string, string[]]> = [
    ["gdelta/encode.js", ["gdelta_encode.wasm"]],
    ["gdelta/decode.js", ["gdelta_decode.wasm"]],
    ["zstd/compress.js", ["zstd_compress.wasm"]],
    ["zstd/decompress.js", ["zstd_decompress.wasm"]],
    [
      "pipeline/index.js",
      ["gdelta_encode.wasm", "gdelta_decode.wasm", "zstd_compress.wasm", "zstd_decompress.wasm"],
    ],
  ];

  for (const [entry, expected] of expectations) {
    it(`${entry} references exactly ${expected.length} wasm artifact(s)`, () => {
      expect([...wasmRefsOf(join(dist, entry))].toSorted()).toEqual(expected.toSorted());
    });
  }
});

describe.skipIf(!built)("entry isolation (runtime)", () => {
  it("decode entry works with only gdelta_decode.wasm present", async () => {
    const old = jsonSnapshot(90, 100);
    const next = mutateSnapshot(old, 91);
    const delta = await encodeDeltaBytes(old, next);
    expect(await decodeDeltaBytes(old, delta)).toEqual(next);

    const scratch = mkdtempSync(join(tmpdir(), "delta-isolation-"));
    try {
      cpSync(dist, join(scratch, "dist"), { recursive: true });
      mkdirSync(join(scratch, "wasm"));
      cpSync(join(wasmDir, "gdelta_decode.wasm"), join(scratch, "wasm", "gdelta_decode.wasm"));

      const script = `
        import { decodeDeltaBytes } from "${join(scratch, "dist", "gdelta", "decode.js")}";
        const [old, delta, expected] = ["OLD", "DELTA", "EXPECTED"].map(
          (k) => new Uint8Array(Buffer.from(process.env[k], "base64")),
        );
        const out = await decodeDeltaBytes(old, delta);
        if (out.length !== expected.length || !out.every((b, i) => b === expected[i])) {
          throw new Error("decode mismatch");
        }
        console.log("ISOLATED_DECODE_OK");
      `;
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
          env: {
            ...process.env,
            OLD: Buffer.from(old).toString("base64"),
            DELTA: Buffer.from(delta).toString("base64"),
            EXPECTED: Buffer.from(next).toString("base64"),
          },
        },
      );
      expect(stdout).toContain("ISOLATED_DECODE_OK");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
