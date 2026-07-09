import { describe, expect, it } from "vitest";
import { compress, compressTransform } from "../src/zstd/compress.js";
import { decompress, decompressTransform } from "../src/zstd/decompress.js";
import { chunked, collectStream, jsonSnapshot, randomBytes, streamOf } from "./helpers.js";

describe("zstd round-trip", () => {
  const fixtures: Array<[string, Uint8Array]> = [
    ["empty", new Uint8Array(0)],
    ["one byte", new Uint8Array([42])],
    ["json 4KB-ish", jsonSnapshot(1, 30)],
    ["json ~50KB", jsonSnapshot(2, 400)],
    ["random 4KB", randomBytes(3, 4096)],
    ["random 1MB", randomBytes(4, 1024 * 1024)],
    ["zeros 256KB", new Uint8Array(256 * 1024)],
  ];

  for (const [name, input] of fixtures) {
    it(`round-trips ${name}`, async () => {
      const compressed = await compress(input);
      const output = await decompress(compressed);
      expect(output).toEqual(input);
    });
  }

  it("compresses compressible data", async () => {
    const input = jsonSnapshot(5, 400);
    const compressed = await compress(input);
    expect(compressed.length).toBeLessThan(input.length / 2);
  });

  it("higher level does not produce larger output on compressible data", async () => {
    const input = jsonSnapshot(6, 400);
    const low = await compress(input, { level: 1 });
    const high = await compress(input, { level: 19 });
    expect(high.length).toBeLessThanOrEqual(low.length);
    expect(await decompress(high)).toEqual(input);
  });
});

describe("zstd streaming", () => {
  it("chunked compression round-trips identically to one-shot", async () => {
    const input = jsonSnapshot(7, 400);
    for (const sizes of [[1], [7, 13, 1], [4096], [65536]] as const) {
      const compressed = await collectStream(
        streamOf(chunked(input, sizes)).pipeThrough(compressTransform()),
      );
      expect(await decompress(compressed)).toEqual(input);
    }
  });

  it("chunked decompression matches one-shot", async () => {
    const input = jsonSnapshot(8, 400);
    const compressed = await compress(input);
    for (const sizes of [[1], [3, 17], [1024]] as const) {
      const output = await collectStream(
        streamOf(chunked(compressed, sizes)).pipeThrough(decompressTransform()),
      );
      expect(output).toEqual(input);
    }
  });

  it("streams output before input ends (does not buffer whole payload)", async () => {
    // Incompressible input: the compressed stream is ~1MB, fed in 4KB
    // chunks, so decompressed output must appear long before input ends.
    const input = randomBytes(11, 1024 * 1024);
    const compressed = await compress(input);
    expect(compressed.length).toBeGreaterThan(512 * 1024);

    let inputDone = false;
    let offset = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= compressed.length) {
          inputDone = true;
          controller.close();
          return;
        }
        controller.enqueue(compressed.subarray(offset, offset + 4096));
        offset += 4096;
      },
    });

    let sawOutputEarly = false;
    for await (const chunk of source.pipeThrough(decompressTransform())) {
      if (chunk.length > 0 && !inputDone) {
        sawOutputEarly = true;
      }
    }
    expect(sawOutputEarly).toBe(true);
  });
});

describe("zstd error handling", () => {
  it("rejects garbage input", async () => {
    await expect(decompress(randomBytes(9, 512))).rejects.toThrow(/corrupt/);
  });

  it("rejects truncated input", async () => {
    const compressed = await compress(jsonSnapshot(10, 100));
    const truncated = compressed.subarray(0, compressed.length - 4);
    await expect(decompress(truncated)).rejects.toThrow(/truncated/);
  });
});
