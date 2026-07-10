/** Deterministic fixtures and stream helpers for the test suites. */

/** mulberry32 PRNG — deterministic across runs. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomBytes(seed: number, length: number): Uint8Array {
  const next = prng(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = Math.floor(next() * 256);
  }
  return out;
}

/** JSON-ish snapshot payload resembling the product's real workload. */
export function jsonSnapshot(seed: number, entries: number): Uint8Array {
  const next = prng(seed);
  const items = Array.from({ length: entries }, (_, i) => ({
    id: `item-${i.toString(36)}-${Math.floor(next() * 1e9).toString(36)}`,
    position: { x: next() * 1000, y: next() * 1000 },
    state: next() > 0.5 ? "active" : "idle",
    score: Math.floor(next() * 10_000),
  }));
  return new TextEncoder().encode(JSON.stringify({ version: 7, items }));
}

/** Applies a few structured mutations to a JSON snapshot (similar payload). */
export function mutateSnapshot(bytes: Uint8Array, seed: number): Uint8Array {
  const next = prng(seed);
  const text = new TextDecoder().decode(bytes);
  const doc = JSON.parse(text) as {
    version: number;
    items: Array<{ score: number; state: string }>;
  };
  doc.version += 1;
  for (let i = 0; i < doc.items.length; i += 17) {
    const item = doc.items[i];
    if (item !== undefined) {
      item.score = Math.floor(next() * 10_000);
      item.state = "moved";
    }
  }
  return new TextEncoder().encode(JSON.stringify(doc));
}

/** Splits bytes into chunks of the given size (or per-chunk sizes cycle). */
export function chunked(bytes: Uint8Array, sizes: number | readonly number[]): Uint8Array[] {
  const sizeList = typeof sizes === "number" ? [sizes] : sizes;
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let i = 0;
  while (offset < bytes.length) {
    const size = Math.max(1, sizeList[i % sizeList.length] ?? 1);
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
    i++;
  }
  return chunks;
}

/** Wraps chunks as a ReadableStream. */
export function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[i];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      i += 1;
      controller.enqueue(chunk);
    },
  });
}

export async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Sliding-window fixture: drop `drop` bytes of head, append `append` fresh bytes. */
export function slideWindow(
  base: Uint8Array,
  drop: number,
  appendSeed: number,
  append: number,
): Uint8Array {
  const tail = randomBytes(appendSeed, append);
  const out = new Uint8Array(base.length - drop + append);
  out.set(base.subarray(drop), 0);
  out.set(tail, base.length - drop);
  return out;
}

/** Concatenates byte buffers. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Minimal gdelta patch writer for adversarial/interop fixtures. */
export function writeVarint(out: number[], value: number): void {
  let v = value;
  for (;;) {
    const byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v === 0) {
      out.push(byte);
      return;
    }
    out.push(byte | 0x80);
  }
}

/** Appends one COPY instruction (head byte + varints). */
export function writeCopy(out: number[], offset: number, length: number): void {
  const head = 0x80 | (length >= 64 ? 0x40 : 0) | (length & 0x3f);
  out.push(head);
  if (length >= 64) {
    writeVarint(out, Math.floor(length / 64));
  }
  writeVarint(out, offset);
}

/** Appends one LITERAL instruction head (data goes in the data region). */
export function writeLiteral(out: number[], length: number): void {
  const head = (length >= 64 ? 0x40 : 0) | (length & 0x3f);
  out.push(head);
  if (length >= 64) {
    writeVarint(out, Math.floor(length / 64));
  }
}

/** Assembles `varint(inst.length) || inst || data` into patch bytes. */
export function buildPatch(
  inst: readonly number[],
  data: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const header: number[] = [];
  writeVarint(header, inst.length);
  const patch = new Uint8Array(header.length + inst.length + data.length);
  patch.set(header, 0);
  patch.set(inst, header.length);
  patch.set(data, header.length + inst.length);
  return patch;
}
