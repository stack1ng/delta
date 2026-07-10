/**
 * Window-limit regression suite for the round-four failures: with a
 * sufficiently large positive cap, every VALID frame must decode exactly as
 * it does uncapped — compact frames at every split point, long runs of
 * concatenated tiny/empty frames at many chunkings, skippable frames, and
 * this library's own smallest framed output. Enforcement is libzstd's own
 * `ZSTD_DCtx_setMaxWindowSize`, so these tests guard the plumbing, not a
 * local reimplementation of frame parsing.
 */

import { describe, expect, it } from "vitest";
import { decodeFramedBytes, encodeFramedBytes } from "../src/pipeline/index.js";
import { compress } from "../src/zstd/compress.js";
import { decompress, decompressTransform } from "../src/zstd/decompress.js";
import { chunked, collectStream, concatBytes, randomBytes, streamOf } from "./helpers.js";

const CAP = 2 * 1024 * 1024; // ≥ the 2 MiB window our level-3 frames declare

describe("compact frames under a positive cap", () => {
  it("decodes tiny frames identically capped and uncapped", async () => {
    for (const length of [0, 1, 2, 3, 4, 8, 16, 32, 64, 128, 1024, 4096]) {
      const input = randomBytes(0x5000 + length, length);
      const frame = await compress(input);
      expect(await decompress(frame)).toEqual(input);
      expect(await decompress(frame, { maxWindowBytes: CAP })).toEqual(input);
    }
  });

  it("decodes a compact frame at every split point", async () => {
    const input = new Uint8Array([0x7b]);
    const frame = await compress(input);
    for (let split = 1; split < frame.length; split++) {
      const output = await collectStream(
        streamOf([frame.subarray(0, split), frame.subarray(split)]).pipeThrough(
          decompressTransform({ maxWindowBytes: CAP }),
        ),
      );
      expect(output).toEqual(input);
    }
  });
});

describe("concatenated compact frames under a positive cap", () => {
  it("decodes 1000 one-byte frames at many chunk sizes", async () => {
    const one = await compress(new Uint8Array([0x7b]));
    const joined = concatBytes(...Array.from({ length: 1000 }, () => one));
    for (const size of [1, 3, 7, 9, 10, 17, 18, 19, 64, joined.length]) {
      const output = await collectStream(
        streamOf(chunked(joined, size)).pipeThrough(decompressTransform({ maxWindowBytes: CAP })),
      );
      expect(output.length).toBe(1000);
    }
  });

  it("decodes 1000 empty frames at many chunk sizes", async () => {
    const empty = await compress(new Uint8Array(0));
    const joined = concatBytes(...Array.from({ length: 1000 }, () => empty));
    for (const size of [1, 2, 7, 9, 17, 18, 64, joined.length]) {
      const output = await collectStream(
        streamOf(chunked(joined, size)).pipeThrough(decompressTransform({ maxWindowBytes: CAP })),
      );
      expect(output.length).toBe(0);
    }
  });
});

describe("skippable frames under a positive cap", () => {
  it("skips a skippable frame ahead of a normal frame at many chunkings", async () => {
    const payload = randomBytes(600, 32);
    const skippable = new Uint8Array(8 + payload.length);
    new DataView(skippable.buffer).setUint32(0, 0x184d2a50, true);
    new DataView(skippable.buffer).setUint32(4, payload.length, true);
    skippable.set(payload, 8);

    const input = randomBytes(601, 2048);
    const joined = concatBytes(skippable, await compress(input));
    for (const size of [1, 5, 9, 17, 18, 40, joined.length]) {
      const output = await collectStream(
        streamOf(chunked(joined, size)).pipeThrough(decompressTransform({ maxWindowBytes: CAP })),
      );
      expect(output).toEqual(input);
    }
  });
});

describe("framed pipeline under a positive cap", () => {
  it("round-trips the smallest fallback:false frame", async () => {
    const framed = await encodeFramedBytes(new Uint8Array(0), new Uint8Array(0), {
      fallback: false,
    });
    expect(framed.length).toBeLessThan(20);
    expect(await decodeFramedBytes(new Uint8Array(0), framed)).toEqual(new Uint8Array(0));
    expect(await decodeFramedBytes(new Uint8Array(0), framed, { maxWindowBytes: CAP })).toEqual(
      new Uint8Array(0),
    );
  });
});

describe("cap range contract", () => {
  it("rejects finite caps below libzstd's 1 KiB minimum window", () => {
    for (const cap of [0, 1, 512, 1023]) {
      expect(() => decompressTransform({ maxWindowBytes: cap })).toThrow(/at least 1024/);
    }
  });

  it("accepts the minimum cap and applies it", async () => {
    // A level-3 stream frame declares a 2 MiB window: the 1 KiB cap is
    // valid but must reject it.
    const frame = await compress(randomBytes(602, 64));
    await expect(decompress(frame, { maxWindowBytes: 1024 })).rejects.toThrow(/maxWindowBytes/);
  });

  it("enforces non-power-of-two caps via libzstd's exact comparison", async () => {
    // Level 19 declares an 8 MiB window regardless of content size.
    const frame = await compress(randomBytes(603, 64), { level: 19 });
    await expect(decompress(frame, { maxWindowBytes: 3 * 1024 * 1024 })).rejects.toThrow(
      /maxWindowBytes/,
    );
    expect((await decompress(frame, { maxWindowBytes: 8 * 1024 * 1024 })).length).toBe(64);
  });

  it("clamps caps beyond the platform maximum instead of failing", async () => {
    const input = randomBytes(604, 256);
    const frame = await compress(input);
    for (const cap of [2 ** 31, 2 ** 40, Number.MAX_SAFE_INTEGER - 1]) {
      expect(await decompress(frame, { maxWindowBytes: cap })).toEqual(input);
    }
  });

  it("still reports truncation with a cap set", async () => {
    const frame = await compress(randomBytes(605, 4096));
    await expect(
      decompress(frame.subarray(0, frame.length - 3), { maxWindowBytes: CAP }),
    ).rejects.toThrow(/truncated/);
  });
});
