/**
 * Size + speed report over representative payloads. Run against the built
 * output: `bun run build && bun run bench` (node >= 23.6 strips types).
 *
 * Not a CI gate — round-trip correctness and entry isolation are gated in
 * vitest; this script is for comparing wire sizes and encode/decode cost.
 */

import { encodeDeltaBytes } from "../dist/gdelta/encode.js";
import { decodeFramedBytes, encodeFramedBytes } from "../dist/pipeline/index.js";
import { compress } from "../dist/zstd/compress.js";

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** JSON-ish snapshot sized roughly to `targetBytes`, plus a mutated twin. */
function snapshotPair(seed: number, targetBytes: number): [Uint8Array, Uint8Array] {
  const next = prng(seed);
  const entries = Math.max(4, Math.round(targetBytes / 130));
  const items = Array.from({ length: entries }, (_, i) => ({
    id: `item-${i.toString(36)}-${Math.floor(next() * 1e9).toString(36)}`,
    position: { x: next() * 1000, y: next() * 1000 },
    state: next() > 0.5 ? "active" : "idle",
    score: Math.floor(next() * 10_000),
  }));
  const doc = { version: 7, items };
  const old = new TextEncoder().encode(JSON.stringify(doc));

  for (let i = 0; i < items.length; i += 17) {
    const item = items[i];
    if (item !== undefined) {
      item.score = Math.floor(next() * 10_000);
      item.state = "moved";
    }
  }
  (doc as { version: number }).version = 8;
  const mutated = new TextEncoder().encode(JSON.stringify(doc));
  return [old, mutated];
}

async function timed<T>(iterations: number, fn: () => Promise<T>): Promise<[T, number]> {
  let result: T = await fn(); // warm-up (wasm init, JIT)
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    result = await fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return [result, times[Math.floor(times.length / 2)] ?? 0];
}

function kb(n: number): string {
  return n < 10_000 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

const sizes = [4 * 1024, 50 * 1024, 256 * 1024, 1024 * 1024];
const iterations = 20;

console.log(
  "| new size | raw gdelta | gdelta+zstd | zstd-only full | framed pick | encode ms | decode ms |",
);
console.log("|---|---|---|---|---|---|---|");

for (const [index, target] of sizes.entries()) {
  const [old, next] = snapshotPair(100 + index, target);

  const [delta] = await timed(iterations, () => encodeDeltaBytes(old, next));
  const deltaZ = await compress(delta);
  const fullZ = await compress(next);
  const [framed, encodeMs] = await timed(iterations, () => encodeFramedBytes(old, next));
  const [roundtrip, decodeMs] = await timed(iterations, () => decodeFramedBytes(old, framed));

  if (roundtrip.length !== next.length || !roundtrip.every((b, i) => b === next[i])) {
    throw new Error(`round-trip mismatch at ${target}`);
  }

  console.log(
    `| ${kb(next.length)} | ${kb(delta.length)} | ${kb(deltaZ.length)} | ${kb(fullZ.length)} | ${kb(
      framed.length,
    )} | ${encodeMs.toFixed(2)} | ${decodeMs.toFixed(2)} |`,
  );
}

console.log(
  "\nframed pick = smallest of {gdelta+zstd, full+zstd, gdelta-raw, raw-full} + 4-byte header (zstd level 3).",
);
console.log("encode ms includes gdelta + both zstd candidate passes (fallback policy).");
