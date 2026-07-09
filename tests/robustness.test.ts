/**
 * Adversarial-input and backpressure behavior: the properties a hostile or
 * buggy producer/consumer would hit, beyond the happy-path suites.
 */

import { describe, expect, it } from "vitest";
import { decodeDelta, decodeDeltaBytes } from "../src/gdelta/decode.js";
import { encodeDelta, encodeDeltaBytes } from "../src/gdelta/encode.js";
import {
  decodeFramed,
  decodeFramedBytes,
  encodeFramedBytes,
  FrameAlgo,
} from "../src/pipeline/index.js";
import { compress, compressTransform } from "../src/zstd/compress.js";
import { decompress, decompressTransform } from "../src/zstd/decompress.js";
import {
  collectStream,
  concatBytes,
  jsonSnapshot,
  mutateSnapshot,
  randomBytes,
  streamOf,
} from "./helpers.js";

/** Resolves to "pending" | "settled" without waiting for the promise. */
async function stateOf(promise: Promise<unknown>): Promise<"pending" | "settled"> {
  const sentinel = Symbol("pending");
  const raced = await Promise.race([
    promise.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<typeof sentinel>((resolve) => setTimeout(() => resolve(sentinel), 25)),
  ]);
  return raced === sentinel ? "pending" : "settled";
}

describe("zstd empty input", () => {
  it("rejects empty input one-shot", async () => {
    await expect(decompress(new Uint8Array(0))).rejects.toThrow(/empty input/);
  });

  it("rejects a stream that closes without bytes on both sides", async () => {
    const { readable, writable } = decompressTransform();
    const closed = writable.getWriter().close();
    await expect(closed).rejects.toThrow(/empty input/);
    await expect(readable.getReader().read()).rejects.toThrow(/empty input/);
  });

  it("still accepts the compressed form of empty input", async () => {
    const compressed = await compress(new Uint8Array(0));
    expect(compressed.length).toBeGreaterThan(0);
    expect(await decompress(compressed)).toEqual(new Uint8Array(0));
  });

  it("decodes concatenated frames", async () => {
    const a = jsonSnapshot(200, 50);
    const b = randomBytes(201, 2048);
    const joined = concatBytes(await compress(a), await compress(b));
    expect(await decompress(joined)).toEqual(concatBytes(a, b));
  });
});

describe("chunk type validation", () => {
  const badChunks: Array<[string, unknown]> = [
    ["a string", "not bytes"],
    ["an ArrayBuffer", new ArrayBuffer(8)],
    ["a number array", [1, 2, 3]],
    ["a DataView", new DataView(new ArrayBuffer(8))],
  ];

  for (const [label, chunk] of badChunks) {
    it(`zstd compress rejects ${label}`, async () => {
      const { writable, readable } = compressTransform();
      const drain = readable
        .getReader()
        .read()
        .catch(() => {});
      const writer = writable.getWriter();
      await expect(writer.write(chunk as Uint8Array)).rejects.toThrow(TypeError);
      await drain;
    });

    it(`zstd decompress rejects ${label}`, async () => {
      const { writable, readable } = decompressTransform();
      const drain = readable
        .getReader()
        .read()
        .catch(() => {});
      const writer = writable.getWriter();
      await expect(writer.write(chunk as Uint8Array)).rejects.toThrow(TypeError);
      await drain;
    });

    it(`gdelta decode rejects ${label} in the delta stream`, async () => {
      const source = streamOf([chunk as Uint8Array]);
      await expect(decodeDeltaBytes(randomBytes(202, 64), source)).rejects.toThrow(TypeError);
    });

    it(`gdelta encode rejects ${label} in the new stream`, async () => {
      const source = streamOf([chunk as Uint8Array]);
      await expect(encodeDeltaBytes(randomBytes(203, 64), source)).rejects.toThrow(TypeError);
    });
  }

  it("gdelta encode rejects a non-buffer old parameter", () => {
    expect(() => encodeDelta("old" as unknown as Uint8Array, new Uint8Array(4))).toThrow(TypeError);
    expect(() => decodeDelta(42 as unknown as Uint8Array, new Uint8Array(4))).toThrow(TypeError);
  });
});

describe("decompression backpressure", () => {
  it("holds the input write pending and emits bounded chunks on demand", async () => {
    // Highly compressible 8 MiB: a few hundred compressed bytes expand
    // ~20,000x, so all expansion must be demand-driven.
    const original = new Uint8Array(8 * 1024 * 1024);
    const compressed = await compress(original);
    expect(compressed.length).toBeLessThan(16 * 1024);

    const { writable, readable } = decompressTransform();
    const writer = writable.getWriter();
    const reader = readable.getReader();

    const write = writer.write(compressed);
    write.catch(() => {});

    const first = await reader.read();
    expect(first.done).toBe(false);
    expect((first.value as Uint8Array).length).toBeLessThanOrEqual(64 * 1024);

    // One pull must not drain the codec: the write is still pending because
    // most of the output has not been asked for yet.
    expect(await stateOf(write)).toBe("pending");

    // Close as soon as the codec releases the write (as a piped source
    // would), and keep reading to completion.
    const finish = write.then(() => writer.close());
    let total = (first.value as Uint8Array).length;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      expect(value.length).toBeLessThanOrEqual(64 * 1024);
      total += value.length;
    }
    expect(total).toBe(original.length);
    await finish;
  });

  it("gdelta decode emits bounded chunks for copy-amplified deltas", async () => {
    // Identical 1 MiB buffers: the delta is a tiny copy-everything patch,
    // so output amplification comes entirely from the base.
    const old = randomBytes(204, 1024 * 1024);
    const delta = await encodeDeltaBytes(old, old);
    expect(delta.length).toBeLessThan(64);

    const reader = decodeDelta(old, delta).getReader();
    const first = await reader.read();
    expect((first.value as Uint8Array).length).toBeLessThanOrEqual(64 * 1024);
    await reader.cancel();
  });

  it("rejects pending writes when the readable is cancelled", async () => {
    const original = new Uint8Array(4 * 1024 * 1024);
    const compressed = await compress(original);

    const { writable, readable } = decompressTransform();
    const writer = writable.getWriter();
    const reader = readable.getReader();
    const write = writer.write(compressed);
    write.catch(() => {});

    await reader.read();
    await reader.cancel(new Error("consumer gone"));
    await expect(write).rejects.toThrow(/consumer gone/);
  });
});

describe("maxOutputBytes", () => {
  it("zstd decompress rejects output beyond the cap", async () => {
    const original = jsonSnapshot(205, 400);
    const compressed = await compress(original);
    await expect(decompress(compressed, { maxOutputBytes: original.length - 1 })).rejects.toThrow(
      /maxOutputBytes/,
    );
    expect(await decompress(compressed, { maxOutputBytes: original.length })).toEqual(original);
  });

  it("gdelta decode rejects output beyond the cap", async () => {
    const old = jsonSnapshot(206, 200);
    const next = mutateSnapshot(old, 207);
    const delta = await encodeDeltaBytes(old, next);
    await expect(decodeDeltaBytes(old, delta, { maxOutputBytes: next.length - 1 })).rejects.toThrow(
      /maxOutputBytes/,
    );
    expect(await decodeDeltaBytes(old, delta, { maxOutputBytes: next.length })).toEqual(next);
  });

  it("framed decode rejects output beyond the cap on every algo path", async () => {
    const old = jsonSnapshot(208, 200);
    const next = mutateSnapshot(old, 209);
    const framedDelta = await encodeFramedBytes(old, next);
    await expect(
      decodeFramedBytes(old, framedDelta, { maxOutputBytes: next.length - 1 }),
    ).rejects.toThrow(/maxOutputBytes/);
    expect(await decodeFramedBytes(old, framedDelta, { maxOutputBytes: next.length })).toEqual(
      next,
    );

    // RawFull path (tiny incompressible payload) is capped centrally.
    const tiny = randomBytes(210, 24);
    const framedRaw = await encodeFramedBytes(new Uint8Array(0), tiny);
    expect(framedRaw[3]).toBe(FrameAlgo.RawFull);
    await expect(
      decodeFramedBytes(new Uint8Array(0), framedRaw, { maxOutputBytes: 8 }),
    ).rejects.toThrow(/maxOutputBytes/);
  });

  it("rejects invalid caps eagerly", () => {
    expect(() => decompressTransform({ maxOutputBytes: -1 })).toThrow(TypeError);
    expect(() => decodeDelta(new Uint8Array(0), new Uint8Array(1), { maxOutputBytes: -1 })).toThrow(
      TypeError,
    );
  });
});

describe("cancellation mid-stream", () => {
  it("gdelta decode survives cancel while awaiting delta input", async () => {
    const old = randomBytes(211, 4096);
    // A source that delivers one chunk and then stalls forever.
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!cancelled) {
          cancelled = true;
          controller.enqueue(new Uint8Array([0x00]));
          return;
        }
        await new Promise(() => {});
      },
      cancel() {},
    });
    const reader = decodeDelta(old, stalled).getReader();
    const pending = reader.read();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await reader.cancel(new Error("gone"));
    await expect(pending).resolves.toMatchObject({ done: true });
  });
});

describe("teardown races (cancel/abort before or during init)", () => {
  it("zstd pair survives cancel before the module finishes loading", async () => {
    const { readable, writable } = decompressTransform();
    await readable.cancel(new Error("early exit"));
    const writer = writable.getWriter();
    await expect(writer.write(new Uint8Array(4))).rejects.toThrow(/early exit/);
  });

  it("writer.abort() settles even with a write in flight and an idle reader", async () => {
    const original = new Uint8Array(4 * 1024 * 1024);
    const compressed = await compress(original);

    const { writable, readable } = decompressTransform();
    const writer = writable.getWriter();
    const reader = readable.getReader();
    const write = writer.write(compressed);
    write.catch(() => {});
    await reader.read(); // one chunk out; write still pending

    await writer.abort(new Error("producer bailed"));
    await expect(write).rejects.toThrow(/producer bailed/);
    await expect(reader.read()).rejects.toThrow(/producer bailed/);
  });

  it("truncated input rejects the writer's close(), not just the readable", async () => {
    const compressed = await compress(jsonSnapshot(212, 100));
    const { writable, readable } = decompressTransform();
    const writer = writable.getWriter();
    const reading = collectStream(readable).catch((error: Error) => error);
    await writer.write(compressed.subarray(0, compressed.length - 4));
    await expect(writer.close()).rejects.toThrow(/truncated/);
    expect(await reading).toBeInstanceOf(Error);
  });

  it("gdelta decode cancel before start cancels the delta source", async () => {
    let sourceCancelled: unknown = null;
    const source = new ReadableStream<Uint8Array>({
      cancel(reason) {
        sourceCancelled = reason;
      },
    });
    const stream = decodeDelta(randomBytes(213, 1024), source);
    await stream.cancel(new Error("gone before start"));
    expect(sourceCancelled).toBeInstanceOf(Error);
  });

  it("framed decode cancel before the inner stage exists resolves cleanly", async () => {
    let sourceCancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      async pull() {
        await new Promise(() => {});
      },
      cancel() {
        sourceCancelled = true;
      },
    });
    const reader = decodeFramed(randomBytes(214, 64), stalled).getReader();
    const pending = reader.read();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Must not reject with "Cannot cancel a locked stream".
    await reader.cancel(new Error("gone"));
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(sourceCancelled).toBe(true);
  });

  it("gdelta encode cancel during start leaves the stream inert", async () => {
    const old = jsonSnapshot(215, 100);
    const next = mutateSnapshot(old, 216);
    const stream = encodeDelta(old, next);
    await stream.cancel(new Error("changed my mind"));
    // A fresh encode still works (shared wasm instance unharmed).
    const delta = await encodeDeltaBytes(old, next);
    expect(await decodeDeltaBytes(old, delta)).toEqual(next);
  });
});
