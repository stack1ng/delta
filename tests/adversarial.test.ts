/**
 * Round-two adversarial fixtures: overflowing varints, high-overhead valid
 * patches under exact caps, instruction amplification, stream ownership,
 * chunk bounds, option strictness, and loader resilience.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeDelta, decodeDeltaBytes } from "../src/gdelta/decode.js";
import { encodeDelta, encodeDeltaBytes } from "../src/gdelta/encode.js";
import { lazyWasm } from "../src/internal/wasm.js";
import {
  decodeFramed,
  decodeFramedBytes,
  encodeFramed,
  encodeFramedBytes,
  FRAME_MAGIC,
  FrameAlgo,
} from "../src/pipeline/index.js";
import { compress } from "../src/zstd/compress.js";
import { decompress, decompressTransform } from "../src/zstd/decompress.js";
import {
  buildPatch,
  concatBytes,
  jsonSnapshot,
  mutateSnapshot,
  randomBytes,
  writeCopy,
} from "./helpers.js";

// Every loader below inits from an explicit source, so the default-URL thunk
// must never run (the lazy contract that keeps import.meta-hostile isolates
// working — see internal/wasm.ts header).
const neverDefaultUrl = (): URL => {
  throw new Error("default URL must not be evaluated for explicit init");
};

const wasmDir = resolve(import.meta.dirname, "..", "wasm");

function stalledSource(): { stream: ReadableStream<Uint8Array>; cancelled(): boolean } {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull() {
      await new Promise(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

describe("malformed varints", () => {
  it("rejects an overflowing header varint instead of decoding empty", async () => {
    // Nine continuation bytes then 0x02: the value is 2^64 and previously
    // wrapped to 0, decoding as a valid empty patch.
    const overflowing = new Uint8Array([...Array(9).fill(0x80), 0x02]);
    await expect(decodeDeltaBytes(new Uint8Array(0), overflowing)).rejects.toThrow(/malformed/);
  });

  it("rejects an eleven-byte varint", async () => {
    const overlong = new Uint8Array([...Array(10).fill(0x80), 0x00]);
    await expect(decodeDeltaBytes(new Uint8Array(0), overlong)).rejects.toThrow(/malformed/);
  });

  it("rejects a unit whose length extension overflows", async () => {
    // literal head with `more`, extension varint = u64::MAX (cannot shift by 6).
    const inst = [0x40, ...Array(9).fill(0xff), 0x01];
    await expect(decodeDeltaBytes(new Uint8Array(0), buildPatch(inst))).rejects.toThrow(
      /malformed/,
    );
  });
});

describe("high-overhead valid patches under exact caps", () => {
  it("accepts 50,000 one-byte copies with the exact output cap", async () => {
    const old = randomBytes(300, 50_000);
    const inst: number[] = [];
    for (let i = 0; i < 50_000; i++) {
      writeCopy(inst, i, 1);
    }
    const patch = buildPatch(inst);
    // The patch is several times larger than its output — that is valid.
    expect(patch.length).toBeGreaterThan(100_000);

    const output = await decodeDeltaBytes(old, patch, { maxOutputBytes: 50_000 });
    expect(output).toEqual(old);
  });

  it("accepts a large zero-output patch with maxOutputBytes 0", async () => {
    const inst: number[] = Array(70_000).fill(0x00); // zero-length literals
    const patch = buildPatch(inst);
    const output = await decodeDeltaBytes(new Uint8Array(0), patch, { maxOutputBytes: 0 });
    expect(output.length).toBe(0);
  });

  it("decodes a 2M zero-length-instruction patch under a 1 MiB cap", async () => {
    // The round-two amplification probe: instructions must not be
    // materialized as parsed structures (the decoder now parses lazily).
    const old = randomBytes(301, 64);
    const inst: number[] = Array(2_000_000).fill(0x00);
    writeCopy(inst, 0, 64);
    const patch = buildPatch(inst);

    const output = await decodeDeltaBytes(old, patch, { maxOutputBytes: 1024 * 1024 });
    expect(output).toEqual(old);
  });

  it("maxPatchBytes bounds the patch itself", async () => {
    const old = jsonSnapshot(302, 200);
    const inst: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      writeCopy(inst, i % old.length, 1);
    }
    const patch = buildPatch(inst);
    await expect(decodeDeltaBytes(old, patch, { maxPatchBytes: patch.length - 1 })).rejects.toThrow(
      /maxPatchBytes/,
    );
    const output = await decodeDeltaBytes(old, patch, { maxPatchBytes: patch.length });
    expect(output.length).toBe(10_000);
  });
});

describe("stream ownership", () => {
  it("encodeDelta cancel releases a stalled streamed new-input", async () => {
    const source = stalledSource();
    const reader = encodeDelta(randomBytes(303, 128), source.stream).getReader();
    const pending = reader.read();
    await new Promise((r) => setTimeout(r, 10));
    await reader.cancel(new Error("gone"));
    expect(source.cancelled()).toBe(true);
    await expect(pending).resolves.toMatchObject({ done: true });
  });

  it("encodeFramed cancel releases a stalled streamed new-input", async () => {
    const source = stalledSource();
    const reader = encodeFramed(randomBytes(304, 128), source.stream).getReader();
    const pending = reader.read();
    await new Promise((r) => setTimeout(r, 10));
    await reader.cancel(new Error("gone"));
    expect(source.cancelled()).toBe(true);
    await expect(pending).resolves.toMatchObject({ done: true });
  });

  it("cancelling an idle decompression pipeline cancels the source", async () => {
    const source = stalledSource();
    const out = source.stream.pipeThrough(decompressTransform());
    const reader = out.getReader();
    const pending = reader.read();
    pending.catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    await reader.cancel(new Error("gone"));
    // pipeTo observes the destination error and propagates backwards.
    await new Promise((r) => setTimeout(r, 20));
    expect(source.cancelled()).toBe(true);
  });

  it("framed decode releases the source lock on success (all algos)", async () => {
    const old = jsonSnapshot(305, 100);
    const bodies: Array<[FrameAlgo, Uint8Array]> = [
      [FrameAlgo.RawFull, old],
      [FrameAlgo.GdeltaRaw, await encodeDeltaBytes(old, old)],
      [FrameAlgo.FullZstd, await compress(old)],
      [FrameAlgo.GdeltaZstd, await compress(await encodeDeltaBytes(old, old))],
    ];
    for (const [algo, body] of bodies) {
      const framed = new Uint8Array(4 + body.length);
      framed.set([FRAME_MAGIC[0], FRAME_MAGIC[1], 0x01, algo]);
      framed.set(body, 4);

      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(framed);
          controller.close();
        },
      });
      expect(await decodeFramedBytes(old, source)).toEqual(old);
      expect(source.locked).toBe(false);
    }
  });

  it("framed decode releases the source lock on malformed magic", async () => {
    const bad = new Uint8Array([0x00, 0x00, 0x01, 0x00, 1, 2, 3]);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bad);
        controller.close();
      },
    });
    await expect(decodeFramedBytes(new Uint8Array(0), source)).rejects.toThrow(/magic/);
    expect(source.locked).toBe(false);
  });
});

describe("zstd window limit", () => {
  it("rejects frames whose window exceeds maxWindowBytes", async () => {
    // Level-3 streaming frames declare a 2 MiB window regardless of content.
    const compressed = await compress(jsonSnapshot(306, 100));
    await expect(decompress(compressed, { maxWindowBytes: 64 * 1024 })).rejects.toThrow(
      /corrupt|window/,
    );
    // A cap covering the declared window decodes fine.
    expect(
      (await decompress(compressed, { maxWindowBytes: 4 * 1024 * 1024 })).length,
    ).toBeGreaterThan(0);
  });
});

describe("chunk bounds", () => {
  it("framed encode emits bounded chunks even for incompressible frames", async () => {
    const next = randomBytes(307, 256 * 1024); // RawFull fallback
    const chunks: Uint8Array[] = [];
    for await (const chunk of encodeFramed(new Uint8Array(0), next)) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(64 * 1024);
    }
    expect(concatBytes(...chunks).length).toBe(4 + next.length);
  });
});

describe("strict options and inputs", () => {
  it("rejects malformed caps", () => {
    for (const bad of ["16", null, 1.5, -1, Number.NaN] as unknown[]) {
      expect(() => decompressTransform({ maxOutputBytes: bad as number })).toThrow(TypeError);
      expect(() =>
        decodeDelta(new Uint8Array(0), new Uint8Array(1), { maxPatchBytes: bad as number }),
      ).toThrow(TypeError);
    }
  });

  it("rejects malformed compression levels", async () => {
    const { compressTransform } = await import("../src/zstd/compress.js");
    for (const bad of ["3", 1.5, Number.NaN, Number.POSITIVE_INFINITY] as unknown[]) {
      expect(() => compressTransform({ level: bad as number })).toThrow(TypeError);
    }
  });

  it("one-shot helpers reject non-Uint8Array input at runtime", () => {
    expect(() => compress(new ArrayBuffer(8) as unknown as Uint8Array)).toThrow(TypeError);
    expect(() => decompress(new DataView(new ArrayBuffer(8)) as unknown as Uint8Array)).toThrow(
      TypeError,
    );
  });

  it("public frame constants are frozen", () => {
    expect(Object.isFrozen(FrameAlgo)).toBe(true);
    expect(Object.isFrozen(FRAME_MAGIC)).toBe(true);
  });
});

describe.skipIf(!existsSync(join(wasmDir, "gdelta_decode.wasm")))("wasm loader", () => {
  it("accepts a Response without the wasm MIME type", async () => {
    const bytes = await readFile(join(wasmDir, "gdelta_decode.wasm"));
    const loader = lazyWasm(neverDefaultUrl, [
      "gdelta_decoder_new",
      "gdelta_decoder_push",
      "gdelta_decoder_read",
      "gdelta_decoder_finish",
      "gdelta_decoder_free",
    ]);
    const response = new Response(bytes, {
      headers: { "Content-Type": "application/octet-stream" },
    });
    await expect(loader.init(response)).resolves.toBeUndefined();
  });

  it("retries after a failed initialization instead of caching the error", async () => {
    const loader = lazyWasm(neverDefaultUrl, [
      "gdelta_decoder_new",
      "gdelta_decoder_push",
      "gdelta_decoder_read",
      "gdelta_decoder_finish",
      "gdelta_decoder_free",
    ]);
    await expect(loader.init(new Uint8Array([1, 2, 3]))).rejects.toThrow();
    const good = await readFile(join(wasmDir, "gdelta_decode.wasm"));
    await expect(loader.init(good)).resolves.toBeUndefined();
  });
});

async function frameBody(algo: number, old: Uint8Array): Promise<Uint8Array> {
  switch (algo) {
    case FrameAlgo.RawFull:
      return old;
    case FrameAlgo.GdeltaRaw:
      return encodeDeltaBytes(old, old);
    case FrameAlgo.FullZstd:
      return compress(old);
    default:
      return compress(await encodeDeltaBytes(old, old));
  }
}

describe("framed source ownership on failure paths", () => {
  it("source error after a valid header unlocks the source (all algos)", async () => {
    const old = jsonSnapshot(400, 100);
    for (const algo of Object.values(FrameAlgo)) {
      const body = await frameBody(algo, old);
      const header = new Uint8Array([FRAME_MAGIC[0], FRAME_MAGIC[1], 0x01, algo]);
      const partial = concatBytes(header, body.subarray(0, Math.floor(body.length / 2)));

      let emitted = false;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!emitted) {
            emitted = true;
            controller.enqueue(partial);
            return;
          }
          controller.error(new Error("network reset"));
        },
      });
      await expect(decodeFramedBytes(old, source)).rejects.toThrow();
      expect(source.locked).toBe(false);
    }
  });

  it("an invalid RawFull body chunk cancels and unlocks a stalled source", async () => {
    let cancelled = false;
    let emitted = false;
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!emitted) {
          emitted = true;
          controller.enqueue(new Uint8Array([FRAME_MAGIC[0], FRAME_MAGIC[1], 0x01, 0x00]));
          controller.enqueue("not bytes" as unknown as Uint8Array);
          return;
        }
        await new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(decodeFramedBytes(new Uint8Array(0), source)).rejects.toThrow(TypeError);
    expect(cancelled).toBe(true);
    expect(source.locked).toBe(false);
  });

  it("immediate cancellation unlocks a prequeued source", async () => {
    const old = jsonSnapshot(401, 50);
    const framed = await encodeFramedBytes(old, old);
    for (let run = 0; run < 20; run++) {
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(framed);
          controller.close();
        },
      });
      const reader = decodeFramed(old, source).getReader();
      await reader.cancel(new Error("gone"));
      expect(source.locked).toBe(false);
    }
  });
});

describe("exact window semantics", () => {
  it("enforces maxWindowBytes byte-exactly against the frame header", async () => {
    // Level-3 streaming frames declare exactly a 2 MiB window.
    const compressed = await compress(jsonSnapshot(402, 100));
    const window = 2 * 1024 * 1024;
    expect((await decompress(compressed, { maxWindowBytes: window })).length).toBeGreaterThan(0);
    await expect(decompress(compressed, { maxWindowBytes: window - 1 })).rejects.toThrow(
      /maxWindowBytes/,
    );
  });

  it("accepts huge finite window caps without rejecting valid frames", async () => {
    const compressed = await compress(jsonSnapshot(403, 100));
    for (const cap of [2 ** 31, Number.MAX_SAFE_INTEGER - 1]) {
      expect((await decompress(compressed, { maxWindowBytes: cap })).length).toBeGreaterThan(0);
    }
  });

  it("applies the window cap through framed decode", async () => {
    const old = jsonSnapshot(404, 200);
    const framed = await encodeFramedBytes(old, mutateSnapshot(old, 405));
    expect(framed[3]).toBe(FrameAlgo.GdeltaZstd);
    await expect(decodeFramedBytes(old, framed, { maxWindowBytes: 64 * 1024 })).rejects.toThrow(
      /maxWindowBytes/,
    );
    expect(await decodeFramedBytes(old, framed, { maxWindowBytes: 2 * 1024 * 1024 })).toEqual(
      mutateSnapshot(old, 405),
    );
  });
});

describe("numeric range strictness", () => {
  it("rejects out-of-range compression levels instead of wrapping", async () => {
    const { compressTransform } = await import("../src/zstd/compress.js");
    for (const bad of [2 ** 32 + 3, 2 ** 40, 23, -131073]) {
      expect(() => compressTransform({ level: bad })).toThrow(TypeError);
    }
    // The true boundaries stay usable.
    const input = jsonSnapshot(406, 50);
    expect(await decompress(await compress(input, { level: 22 }))).toEqual(input);
    expect(await decompress(await compress(input, { level: -131072 }))).toEqual(input);
  });

  it("rejects unsafe-large byte caps", () => {
    for (const bad of [1e100, 2 ** 53, Number.MAX_VALUE]) {
      expect(() => decompressTransform({ maxOutputBytes: bad })).toThrow(TypeError);
    }
    expect(() => decompressTransform({ maxOutputBytes: 2 ** 53 - 1 })).not.toThrow();
  });
});

describe.skipIf(!existsSync(join(wasmDir, "gdelta_decode.wasm")))("minimal runtimes", () => {
  it("explicit byte init works without a global Response", async () => {
    const bytes = await readFile(join(wasmDir, "gdelta_decode.wasm"));
    const originalResponse = globalThis.Response;
    // biome-ignore lint/suspicious/noExplicitAny: deliberate global surgery
    (globalThis as any).Response = undefined;
    try {
      const loader = lazyWasm(neverDefaultUrl, [
        "gdelta_decoder_new",
        "gdelta_decoder_push",
        "gdelta_decoder_read",
        "gdelta_decoder_finish",
        "gdelta_decoder_free",
      ]);
      await expect(loader.init(new Uint8Array(bytes))).resolves.toBeUndefined();
    } finally {
      globalThis.Response = originalResponse;
    }
  });
});

describe.skipIf(!existsSync(join(wasmDir, "gdelta_decode.wasm")))(
  "encode result-trap safety",
  () => {
    it("frees a live result handle when its accessor traps, leaving the module reusable", async () => {
      // The evaluator's synthetic ABI module (vendored fixture): walloc fails
      // while a result handle is live, gdelta_result_ptr traps, and
      // gdelta_result_free releases the handle — so a second encode succeeds
      // only if the first, trapping encode disposed its handle.
      const fixture = await WebAssembly.compile(
        await readFile(join(import.meta.dirname, "fixtures", "gdelta-result-access-fail.wasm")),
      );
      // Cache-busting import: a fresh module instance whose lazyWasm cache is
      // private to this test, so the shared entry stays untouched.
      const dist = join(import.meta.dirname, "..", "dist", "gdelta", "encode.js");
      const entry = (await import(`${pathToFileURL(dist).href}?trap-probe`)) as {
        init(source: WebAssembly.Module): Promise<void>;
        encodeDeltaBytes(a: Uint8Array, b: Uint8Array): Promise<Uint8Array>;
      };
      await entry.init(fixture);

      await expect(entry.encodeDeltaBytes(new Uint8Array(0), new Uint8Array(0))).rejects.toThrow();
      // Proof the handle was freed: with a live (leaked) handle the fixture's
      // walloc returns zero, so a leak surfaces as "wasm memory exhausted".
      // The fixed path gets past allocation and hits the same accessor trap.
      await expect(entry.encodeDeltaBytes(new Uint8Array(0), new Uint8Array([1]))).rejects.toThrow(
        /unreachable/,
      );
    });
  },
);

describe.skipIf(!existsSync(join(wasmDir, "gdelta_decode.wasm")))("init() ABI validation", () => {
  const entries: Array<[string, string, string]> = [
    ["gdelta/encode.js", "gdelta_encode.wasm", "gdelta_decode.wasm"],
    ["gdelta/decode.js", "gdelta_decode.wasm", "zstd_compress.wasm"],
    ["zstd/compress.js", "zstd_compress.wasm", "zstd_decompress.wasm"],
    ["zstd/decompress.js", "zstd_decompress.wasm", "gdelta_encode.wasm"],
  ];

  for (const [entry, correct, wrong] of entries) {
    it(`${entry} rejects a wrong-direction module, then a correct retry works`, async () => {
      const dist = join(import.meta.dirname, "..", "dist", entry);
      const mod = (await import(`${pathToFileURL(dist).href}?abi-${entry}`)) as {
        init(source: WebAssembly.Module): Promise<void>;
      };
      const wrongModule = await WebAssembly.compile(await readFile(join(wasmDir, wrong)));
      await expect(mod.init(wrongModule)).rejects.toThrow(/missing required exports/);
      // The bad instance must not be cached: a correct init now succeeds.
      const correctModule = await WebAssembly.compile(await readFile(join(wasmDir, correct)));
      await expect(mod.init(correctModule)).resolves.toBeUndefined();
    });
  }

  it("a validated entry operates byte-exactly after the failed init", async () => {
    const dist = join(import.meta.dirname, "..", "dist", "zstd", "decompress.js");
    const mod = (await import(`${pathToFileURL(dist).href}?abi-op`)) as {
      init(source: WebAssembly.Module): Promise<void>;
      decompress(bytes: Uint8Array): Promise<Uint8Array>;
    };
    const wrongModule = await WebAssembly.compile(
      await readFile(join(wasmDir, "gdelta_decode.wasm")),
    );
    await expect(mod.init(wrongModule)).rejects.toThrow(/missing required exports/);
    await mod.init(
      await WebAssembly.compile(await readFile(join(wasmDir, "zstd_decompress.wasm"))),
    );
    const input = jsonSnapshot(700, 100);
    expect(await mod.decompress(await compress(input))).toEqual(input);
  });
});

const uleb = (value: number): number[] => {
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (rest !== 0);
  return bytes;
};
const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];
const wasmName = (value: string): number[] => {
  const bytes = [...new TextEncoder().encode(value)];
  return [...uleb(bytes.length), ...bytes];
};

/**
 * Structurally valid module exporting every expected name with wrong JS
 * value kinds: `memory` is an i32 global, every callable a () -> () func.
 */
function wrongKindModule(required: readonly string[]): Promise<WebAssembly.Module> {
  const functions = ["walloc", "wfree", ...required];
  const exportEntries = [
    [...wasmName("memory"), 3, 0],
    ...functions.map((name, index) => [...wasmName(name), 0, ...uleb(index)]),
  ];
  return WebAssembly.compile(
    Uint8Array.from([
      0x00,
      0x61,
      0x73,
      0x6d,
      0x01,
      0x00,
      0x00,
      0x00,
      ...section(1, [1, 0x60, 0, 0]),
      ...section(3, [...uleb(functions.length), ...functions.map(() => 0)]),
      ...section(6, [1, 0x7f, 0, 0x41, 0, 0x0b]),
      ...section(7, [...uleb(exportEntries.length), ...exportEntries.flat()]),
      ...section(10, [...uleb(functions.length), ...functions.flatMap(() => [2, 0, 0x0b])]),
    ]),
  );
}

describe.skipIf(!existsSync(join(wasmDir, "zstd_decompress.wasm")))(
  "init() export kind validation",
  () => {
    const required = [
      "zstd_decomp_new",
      "zstd_decomp_transform",
      "zstd_decomp_done",
      "zstd_decomp_free",
    ];

    it("rejects wrong export value kinds, then a correct retry is byte-correct", async () => {
      const dist = join(import.meta.dirname, "..", "dist", "zstd", "decompress.js");
      const mod = (await import(`${pathToFileURL(dist).href}?kind-probe`)) as {
        init(source: WebAssembly.Module): Promise<void>;
        decompress(bytes: Uint8Array): Promise<Uint8Array>;
      };
      await expect(mod.init(await wrongKindModule(required))).rejects.toThrow(
        /wrong kinds.*memory is not a WebAssembly\.Memory/,
      );
      await mod.init(
        await WebAssembly.compile(await readFile(join(wasmDir, "zstd_decompress.wasm"))),
      );
      const input = jsonSnapshot(500, 77);
      expect(await mod.decompress(await compress(input))).toEqual(input);
    });

    it("init() after success is a no-op that never executes a later module", async () => {
      const dist = join(import.meta.dirname, "..", "dist", "zstd", "decompress.js");
      const mod = (await import(`${pathToFileURL(dist).href}?singleton-probe`)) as {
        init(source?: WebAssembly.Module): Promise<void>;
        decompress(bytes: Uint8Array): Promise<Uint8Array>;
      };
      await mod.init(
        await WebAssembly.compile(await readFile(join(wasmDir, "zstd_decompress.wasm"))),
      );
      const input = jsonSnapshot(400, 78);
      const frame = await compress(input);
      expect(await mod.decompress(frame)).toEqual(input);

      // init() must take effect only before first use: a later source is
      // ignored without being instantiated. This module traps in its start
      // function, so any execution side effect would surface as rejection.
      const trapOnStart = await WebAssembly.compile(
        Uint8Array.from([
          0x00,
          0x61,
          0x73,
          0x6d,
          0x01,
          0x00,
          0x00,
          0x00,
          ...section(1, [1, 0x60, 0, 0]),
          ...section(3, [1, 0]),
          ...section(8, [0]),
          ...section(10, [1, 3, 0, 0x00, 0x0b]),
        ]),
      );
      await expect(mod.init(trapOnStart)).resolves.toBeUndefined();
      expect(await mod.decompress(frame)).toEqual(input);
    });
  },
);

describe("gdelta decode source-reader ownership", () => {
  it("overlapping pull failure and consumer cancel settle cleanly", async () => {
    let sourceCancels = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        // One oversized chunk trips maxPatchBytes inside decode's pull.
        controller.enqueue(new Uint8Array(2048));
      },
      cancel() {
        sourceCancels += 1;
        // Settle slowly so a competing abandonment can arrive mid-await.
        return new Promise((r) => setTimeout(r, 30));
      },
    });
    const reader = decodeDelta(new Uint8Array(4), source, { maxPatchBytes: 1024 }).getReader();
    const read = reader.read();
    read.catch(() => {});
    // Let the pull failure enter abandonSource and start awaiting the slow
    // source cancel, then race the public cancel against it. The regression
    // guarded here: the competing abandonment must not surface a secondary
    // undefined-reader TypeError out of the public cancel().
    await new Promise((r) => setTimeout(r, 10));
    await expect(reader.cancel("consumer cancel")).resolves.toBeUndefined();
    // Cancellation was requested first, so the pending read settles closed.
    await expect(read).resolves.toMatchObject({ done: true });
    expect(sourceCancels).toBe(1);
  });

  it("a re-entrant source-callback cancel joins the published abandonment", async () => {
    let upstreamCancelCalls = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    let signalEntered!: () => void;
    const enteredSourceCancel = new Promise<void>((r) => {
      signalEntered = r;
    });

    let reader!: ReadableStreamDefaultReader<Uint8Array>;
    let reentrantCancel!: Promise<void>;
    let reentrantSettled = false;

    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        // One oversized chunk trips maxPatchBytes inside decode's pull.
        controller.enqueue(new Uint8Array(2048));
      },
      cancel() {
        upstreamCancelCalls += 1;
        // User code re-entering the output's public cancel() synchronously,
        // while this upstream cancellation is still gated: it must join the
        // published abandonment, not take the pre-start branch and fulfill.
        reentrantCancel = reader.cancel("re-entrant").then(() => {
          reentrantSettled = true;
        });
        signalEntered();
        return gate;
      },
    });

    reader = decodeDelta(new Uint8Array(4), source, { maxPatchBytes: 1024 }).getReader();
    const read = reader.read();
    read.catch(() => {});

    // Synchronize on actual entry into the source cancel callback (the
    // pull-failure path has claimed the reader by then, by construction).
    await enteredSourceCancel;
    await new Promise((r) => setTimeout(r, 20));
    expect(reentrantSettled).toBe(false);
    expect(source.locked).toBe(true);

    releaseGate();
    await reentrantCancel;
    expect(reentrantSettled).toBe(true);
    expect(source.locked).toBe(false);
    expect(upstreamCancelCalls).toBe(1);
    await expect(read).resolves.toMatchObject({ done: true });
  });
});
