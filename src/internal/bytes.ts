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

/**
 * Validates a byte-cap option: a non-negative safe integer or Infinity.
 * `undefined` means uncapped. Safe integers only — larger values cannot
 * count bytes exactly across the JS/wasm boundary.
 */
export function validateByteCap(value: number | undefined, name: string): number {
  if (value === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  const valid =
    typeof value === "number" &&
    value >= 0 &&
    (value === Number.POSITIVE_INFINITY || Number.isSafeInteger(value));
  if (!valid) {
    throw new TypeError(`${name} must be a non-negative safe integer (or Infinity)`);
  }
  return value;
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

/** A [`collect`] whose source can be cancelled while collection is running. */
export interface CancelableCollect {
  /** Resolves with everything read before completion or cancellation. */
  promise: Promise<Uint8Array>;
  /** Cancels the underlying source; the promise then resolves early. */
  cancel(reason?: unknown): Promise<void>;
}

/**
 * Like {@link collect}, but retains the reader so a stream-consumer's
 * `cancel()` can propagate to the source instead of leaving it locked.
 */
export function collectCancelable(stream: ReadableStream<Uint8Array>): CancelableCollect {
  const reader = stream.getReader();
  const promise = (async () => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        requireBytes(value);
        chunks.push(value);
        total += value.length;
      }
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    return concat(chunks, total);
  })();
  return {
    promise,
    async cancel(reason?: unknown): Promise<void> {
      await reader.cancel(reason).catch(() => {});
    },
  };
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
  requireBytes(bytes);
  return new ReadableStream({
    start(controller) {
      if (bytes.length > 0) {
        controller.enqueue(bytes);
      }
      controller.close();
    },
  });
}
