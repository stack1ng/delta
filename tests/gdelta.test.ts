import { describe, expect, it } from "vitest";
import { decodeDelta, decodeDeltaBytes } from "../src/gdelta/decode.js";
import { encodeDelta, encodeDeltaBytes } from "../src/gdelta/encode.js";
import {
  chunked,
  collectStream,
  jsonSnapshot,
  mutateSnapshot,
  randomBytes,
  slideWindow,
  streamOf,
} from "./helpers.js";

describe("gdelta round-trip", () => {
  const base50k = jsonSnapshot(20, 400);
  const fixtures: Array<[string, Uint8Array, Uint8Array]> = [
    ["identical buffers", base50k, base50k],
    [
      "small text edit",
      new TextEncoder().encode("The quick brown fox jumps over the lazy dog"),
      new TextEncoder().encode("The quick brown cat jumps over the lazy dog"),
    ],
    ["json snapshot mutation", base50k, mutateSnapshot(base50k, 21)],
    [
      "sliding window drop-head/append-tail",
      randomBytes(22, 64 * 1024),
      slideWindow(randomBytes(22, 64 * 1024), 8 * 1024, 23, 8 * 1024),
    ],
    ["unrelated random buffers", randomBytes(24, 16 * 1024), randomBytes(25, 16 * 1024)],
    ["empty new", randomBytes(26, 4096), new Uint8Array(0)],
    ["empty old", new Uint8Array(0), randomBytes(27, 4096)],
    ["both empty", new Uint8Array(0), new Uint8Array(0)],
    ["large 256KB patterned", jsonSnapshot(28, 2000), mutateSnapshot(jsonSnapshot(28, 2000), 29)],
  ];

  for (const [name, old, next] of fixtures) {
    it(`round-trips ${name}`, async () => {
      const delta = await encodeDeltaBytes(old, next);
      const output = await decodeDeltaBytes(old, delta);
      expect(output).toEqual(next);
    });
  }

  it("produces a small delta for similar inputs", async () => {
    const old = jsonSnapshot(30, 400);
    const next = mutateSnapshot(old, 31);
    const delta = await encodeDeltaBytes(old, next);
    expect(delta.length).toBeLessThan(next.length / 2);
  });

  it("accepts old as ArrayBuffer", async () => {
    const old = randomBytes(32, 2048);
    const next = slideWindow(old, 128, 33, 128);
    const oldCopy = old.buffer.slice(old.byteOffset, old.byteOffset + old.byteLength);
    const delta = await encodeDeltaBytes(oldCopy as ArrayBuffer, next);
    expect(await decodeDeltaBytes(oldCopy as ArrayBuffer, delta)).toEqual(next);
  });

  it("accepts new as a ReadableStream (buffered internally)", async () => {
    const old = jsonSnapshot(34, 100);
    const next = mutateSnapshot(old, 35);
    const delta = await collectStream(encodeDelta(old, streamOf(chunked(next, 1024))));
    expect(await decodeDeltaBytes(old, delta)).toEqual(next);
  });
});

describe("gdelta decode streaming", () => {
  it("matches one-shot for all delta chunkings", async () => {
    const old = jsonSnapshot(40, 400);
    const next = mutateSnapshot(old, 41);
    const delta = await encodeDeltaBytes(old, next);

    for (const sizes of [[1], [2, 3, 5], [64], [4096]] as const) {
      const output = await collectStream(decodeDelta(old, streamOf(chunked(delta, sizes))));
      expect(output).toEqual(next);
    }
  });

  it("emits output before the delta input ends", async () => {
    // A delta dominated by literal bytes (unrelated data) arrives in small
    // chunks; reconstructed output must appear before the last chunk.
    const old = randomBytes(42, 1024);
    const next = randomBytes(43, 512 * 1024);
    const delta = await encodeDeltaBytes(old, next);

    let inputDone = false;
    let offset = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= delta.length) {
          inputDone = true;
          controller.close();
          return;
        }
        controller.enqueue(delta.subarray(offset, offset + 4096));
        offset += 4096;
      },
    });

    let sawOutputEarly = false;
    for await (const chunk of decodeDelta(old, source)) {
      if (chunk.length > 0 && !inputDone) {
        sawOutputEarly = true;
      }
    }
    expect(sawOutputEarly).toBe(true);
  });
});

describe("gdelta decode errors", () => {
  it("rejects a truncated delta", async () => {
    const old = jsonSnapshot(50, 100);
    const next = mutateSnapshot(old, 51);
    const delta = await encodeDeltaBytes(old, next);
    await expect(decodeDeltaBytes(old, delta.subarray(0, delta.length - 1))).rejects.toThrow(
      /truncated/,
    );
  });

  it("rejects trailing bytes", async () => {
    const old = jsonSnapshot(52, 100);
    const next = mutateSnapshot(old, 53);
    const delta = await encodeDeltaBytes(old, next);
    const padded = new Uint8Array(delta.length + 1);
    padded.set(delta);
    padded[delta.length] = 0xff;
    await expect(decodeDeltaBytes(old, padded)).rejects.toThrow(/trailing/);
  });

  it("rejects a delta whose copies exceed the base", async () => {
    const old = jsonSnapshot(54, 200);
    const next = mutateSnapshot(old, 55);
    const delta = await encodeDeltaBytes(old, next);
    // Decode against a shorter base than the one used to encode.
    await expect(decodeDeltaBytes(old.subarray(0, 64), delta)).rejects.toThrow(/bounds/);
  });

  it("rejects an empty delta", async () => {
    await expect(decodeDeltaBytes(randomBytes(56, 128), new Uint8Array(0))).rejects.toThrow();
  });
});
