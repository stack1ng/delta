import { describe, expect, it } from "vitest";
import {
  decodeFramed,
  decodeFramedBytes,
  encodeFramed,
  encodeFramedBytes,
  FRAME_MAGIC,
  FRAME_VERSION,
  FrameAlgo,
} from "../src/pipeline/index.js";
import { compress } from "../src/zstd/compress.js";
import {
  chunked,
  collectStream,
  jsonSnapshot,
  mutateSnapshot,
  randomBytes,
  streamOf,
} from "./helpers.js";

describe("framed pipeline round-trip", () => {
  const cases: Array<[string, Uint8Array, Uint8Array]> = [
    ["similar json snapshots", jsonSnapshot(60, 400), mutateSnapshot(jsonSnapshot(60, 400), 61)],
    ["identical buffers", jsonSnapshot(62, 100), jsonSnapshot(62, 100)],
    ["unrelated random", randomBytes(63, 32 * 1024), randomBytes(64, 32 * 1024)],
    ["empty new", jsonSnapshot(65, 50), new Uint8Array(0)],
    ["empty old", new Uint8Array(0), jsonSnapshot(66, 50)],
    ["tiny payload", new TextEncoder().encode("ab"), new TextEncoder().encode("ac")],
  ];

  for (const [name, old, next] of cases) {
    it(`round-trips ${name}`, async () => {
      const framed = await encodeFramedBytes(old, next);
      expect(framed[0]).toBe(FRAME_MAGIC[0]);
      expect(framed[1]).toBe(FRAME_MAGIC[1]);
      expect(framed[2]).toBe(FRAME_VERSION);
      const output = await decodeFramedBytes(old, framed);
      expect(output).toEqual(next);
    });
  }

  it("round-trips through streams with chunked input", async () => {
    const old = jsonSnapshot(67, 400);
    const next = mutateSnapshot(old, 68);
    const framed = await collectStream(encodeFramed(old, streamOf(chunked(next, 1024))));
    for (const sizes of [[1], [7, 13], [4096]] as const) {
      const output = await collectStream(decodeFramed(old, streamOf(chunked(framed, sizes))));
      expect(output).toEqual(next);
    }
  });

  it("picks gdelta+zstd for similar payloads", async () => {
    const old = jsonSnapshot(69, 400);
    const next = mutateSnapshot(old, 70);
    const framed = await encodeFramedBytes(old, next);
    expect(framed[3]).toBe(FrameAlgo.GdeltaZstd);
    // The whole point: much smaller than compressing the snapshot fresh.
    const fullZ = await compress(next);
    expect(framed.length).toBeLessThan(fullZ.length / 2);
  });
});

describe("framed fallback policy", () => {
  it("never sends a body larger than the best full-snapshot candidate", async () => {
    const old = randomBytes(71, 64 * 1024);
    const next = randomBytes(72, 64 * 1024); // dissimilar: delta cannot help
    const framed = await encodeFramedBytes(old, next);
    const fullZ = await compress(next);
    expect(framed.length).toBeLessThanOrEqual(4 + Math.min(fullZ.length, next.length));
    expect(await decodeFramedBytes(old, framed)).toEqual(next);
  });

  it("uses raw-full for tiny incompressible payloads", async () => {
    const old = new Uint8Array(0);
    const next = randomBytes(73, 24);
    const framed = await encodeFramedBytes(old, next);
    expect(framed[3]).toBe(FrameAlgo.RawFull);
    expect(framed.length).toBe(4 + next.length);
    expect(await decodeFramedBytes(old, framed)).toEqual(next);
  });

  it("fallback:false always emits gdelta+zstd", async () => {
    const old = randomBytes(74, 8 * 1024);
    const next = randomBytes(75, 8 * 1024);
    const framed = await encodeFramedBytes(old, next, { fallback: false });
    expect(framed[3]).toBe(FrameAlgo.GdeltaZstd);
    expect(await decodeFramedBytes(old, framed)).toEqual(next);
  });

  it("honors zstdLevel", async () => {
    const old = new Uint8Array(0);
    const next = jsonSnapshot(76, 800);
    const low = await encodeFramedBytes(old, next, { zstdLevel: 1 });
    const high = await encodeFramedBytes(old, next, { zstdLevel: 19 });
    expect(high.length).toBeLessThanOrEqual(low.length);
    expect(await decodeFramedBytes(old, high)).toEqual(next);
  });
});

async function framedFixture(): Promise<{ old: Uint8Array; framed: Uint8Array }> {
  const old = jsonSnapshot(80, 50);
  const framed = await encodeFramedBytes(old, mutateSnapshot(old, 81));
  return { old, framed };
}

describe("frame validation", () => {
  it("rejects bad magic", async () => {
    const { old, framed } = await framedFixture();
    const bad = framed.slice();
    bad[0] = 0x00;
    await expect(decodeFramedBytes(old, bad)).rejects.toThrow(/magic/);
  });

  it("rejects unknown version", async () => {
    const { old, framed } = await framedFixture();
    const bad = framed.slice();
    bad[2] = 0x7f;
    await expect(decodeFramedBytes(old, bad)).rejects.toThrow(/version/);
  });

  it("rejects unknown algorithm", async () => {
    const { old, framed } = await framedFixture();
    const bad = framed.slice();
    bad[3] = 0x7f;
    await expect(decodeFramedBytes(old, bad)).rejects.toThrow(/algorithm/);
  });

  it("rejects truncated header", async () => {
    const { old, framed } = await framedFixture();
    await expect(decodeFramedBytes(old, framed.subarray(0, 3))).rejects.toThrow(/header/);
  });

  it("rejects a corrupted body", async () => {
    const { old, framed } = await framedFixture();
    const bad = framed.slice();
    for (let i = 4; i < Math.min(bad.length, 64); i++) {
      bad[i] = (bad[i] ?? 0) ^ 0xa5;
    }
    await expect(decodeFramedBytes(old, bad)).rejects.toThrow();
  });
});
