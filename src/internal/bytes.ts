/** Byte/stream helpers shared by the entrypoints. No wasm references here. */

/** Rejects stream chunks that are not actual bytes (strings, ArrayBuffers, …). */
export function requireBytes(chunk: unknown): asserts chunk is Uint8Array {
  if (!(chunk instanceof Uint8Array)) {
    throw new TypeError("expected a Uint8Array chunk");
  }
}

/** Normalizes accepted binary input to a Uint8Array without copying. */
export function asBytes(input: Uint8Array | ArrayBuffer): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  throw new TypeError("expected a Uint8Array or ArrayBuffer");
}

/** Collects an entire ReadableStream into one Uint8Array. */
export async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    requireBytes(chunk);
    chunks.push(chunk);
    total += chunk.length;
  }
  return concat(chunks, total);
}

/** Concatenates chunks into one Uint8Array. */
export function concat(chunks: readonly Uint8Array[], total?: number): Uint8Array {
  const length = total ?? chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Wraps a single buffer as a one-chunk ReadableStream. */
export function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.length > 0) {
        controller.enqueue(bytes);
      }
      controller.close();
    },
  });
}
