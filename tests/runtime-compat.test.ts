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
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { build, type Plugin } from "esbuild";
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

const convexWasmPlugin: Plugin = {
  name: "convex-wasm",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\.wasm$/ }, (args) => {
      if (args.namespace === "wasm-stub") {
        return { path: args.path, namespace: "wasm-binary" };
      }
      if (args.resolveDir === "") {
        return;
      }
      return {
        path: isAbsolute(args.path) ? args.path : join(args.resolveDir, args.path),
        namespace: "wasm-stub",
      };
    });
    pluginBuild.onLoad({ filter: /.*/, namespace: "wasm-stub" }, (args) => ({
      contents: `import wasm from ${JSON.stringify(args.path)};
        export default new WebAssembly.Module(wasm);`,
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "wasm-binary" }, (args) => ({
      contents: readFileSync(args.path),
      loader: "binary",
    }));
  },
};

function installPackage(scratch: string): void {
  const installed = join(scratch, "node_modules", "@stack1ng", "delta");
  mkdirSync(installed, { recursive: true });
  for (const item of ["dist", "wasm", "package.json"]) {
    cpSync(join(root, item), join(installed, item), { recursive: true });
  }
}

async function bundleForConvex(scratch: string, contents: string) {
  return build({
    stdin: { resolveDir: scratch, contents },
    bundle: true,
    conditions: ["convex", "module"],
    format: "esm",
    logLevel: "silent",
    plugins: [convexWasmPlugin],
    platform: "browser",
    target: "es2023",
    write: false,
  });
}

function bundledArtifacts(bundle: Awaited<ReturnType<typeof bundleForConvex>>): string[] {
  const code = bundle.outputFiles[0]?.text ?? "";
  return ["gdelta_decode", "gdelta_encode", "zstd_compress", "zstd_decompress"]
    .filter((artifact) => code.includes(artifact))
    .map((artifact) => `${artifact}.wasm`);
}

describe.skipIf(!built)("Convex isolate", () => {
  it("imports the package normally and runs the full pipeline without consumer setup", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "delta-isolate-"));
    try {
      installPackage(scratch);
      const bundle = await bundleForConvex(
        scratch,
        [
          'import { encodeFramedBytes } from "@stack1ng/delta/pipeline/encode";',
          'import { decodeFramedBytes } from "@stack1ng/delta/pipeline/decode";',
          'Object.defineProperty(WritableStreamDefaultController.prototype, "signal", { configurable: true, get() { throw new TypeError("signal unsupported"); } });',
          "const old = Uint8Array.from({ length: 4096 }, (_, i) => i % 251);",
          "const next = Uint8Array.from({ length: 4600 }, (_, i) => (i % 251) ^ (i > 4000 ? 7 : 0));",
          "const framed = await encodeFramedBytes(old, next, { fallback: false });",
          "const out = await decodeFramedBytes(old, framed);",
          'if (out.length !== next.length || !out.every((b, i) => b === next[i])) throw new Error("mismatch");',
          'console.log("CONVEX_GATE_OK");',
        ].join("\n"),
      );
      expect(bundledArtifacts(bundle)).toEqual([
        "gdelta_decode.wasm",
        "gdelta_encode.wasm",
        "zstd_compress.wasm",
        "zstd_decompress.wasm",
      ]);
      const code = bundle.outputFiles[0]?.text;
      if (code === undefined || !code.includes("import.meta")) {
        throw new Error("invalid isolate bundle");
      }
      const file = join(scratch, "bundle.mjs");
      const gate = join(scratch, "gate.mjs");
      writeFileSync(file, code);
      writeFileSync(
        gate,
        `
          import vm from "node:vm";
          import { readFile } from "node:fs/promises";
          const context = vm.createContext({ console, atob, ReadableStream, WritableStream, WritableStreamDefaultController, TransformStream });
          const mod = new vm.SourceTextModule(await readFile(${JSON.stringify(file)}, "utf8"), {
            context,
            initializeImportMeta() { throw new TypeError("import.meta unsupported"); },
          });
          await mod.link(() => { throw new Error("bundle must be self-contained"); });
          await mod.evaluate();
        `,
      );
      const result = spawnSync(process.execPath, ["--experimental-vm-modules", gate], {
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.stderr).not.toContain("import.meta unsupported");
      expect(result.stdout).toContain("CONVEX_GATE_OK");
      expect(result.status).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("keeps root and pipeline imports isolated to the wasm they use", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "delta-isolation-"));
    try {
      installPackage(scratch);
      const leaf = await bundleForConvex(
        scratch,
        'import { decodeDelta } from "@stack1ng/delta"; console.log(decodeDelta);',
      );
      expect(bundledArtifacts(leaf)).toEqual(["gdelta_decode.wasm"]);

      const pipeline = await bundleForConvex(
        scratch,
        'import { decodeFramed } from "@stack1ng/delta/pipeline"; console.log(decodeFramed);',
      );
      expect(bundledArtifacts(pipeline)).toEqual(["gdelta_decode.wasm", "zstd_decompress.wasm"]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
