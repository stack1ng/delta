/**
 * Framed pipeline, encode direction: gdelta encode → zstd compress behind
 * the versioned frame. Importing only this entry pulls only the
 * encode-side wasm (gdelta encode + zstd compress).
 */

import { encodeDeltaBytes } from "../gdelta/encode.js";
import { asBytes, type CancelableCollect, collect, collectCancelable } from "../internal/bytes.js";
import { compress } from "../zstd/compress.js";
import { FrameAlgo, frameHeader } from "./frame.js";

const CHUNK = 64 * 1024;

export interface FramedEncodeOptions {
  /** Zstd level for the compressed candidates (default 3). */
  zstdLevel?: number;
  /**
   * When true (default), also compress the full `new` bytes and send that
   * (or the raw bytes) whenever it beats the compressed delta — at the cost
   * of one extra zstd pass over `new`. When false, the frame is always
   * `GdeltaZstd`.
   */
  fallback?: boolean;
}

/**
 * Encodes `old → new` as a framed wire payload.
 *
 * Both inputs end up fully buffered — gdelta encode inherently needs full
 * random access to both, and candidate selection needs candidate sizes — so
 * this facade trades streaming input for the smallest wire size. The result
 * streams out in bounded (≤64 KiB) chunks: the 4-byte header first, then
 * views of the winning body (never a concatenated copy).
 */
export function encodeFramed(
  old: Uint8Array | ArrayBuffer,
  newBytes: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
  options?: FramedEncodeOptions,
): ReadableStream<Uint8Array> {
  let cancelled = false;
  let source: CancelableCollect | undefined;
  let header: Uint8Array | undefined;
  let body: Uint8Array | undefined;
  let headerSent = false;
  let offset = 0;

  return new ReadableStream<Uint8Array>({
    async start() {
      let target: Uint8Array;
      if (newBytes instanceof ReadableStream) {
        source = collectCancelable(newBytes);
        target = await source.promise;
        source = undefined;
      } else {
        target = asBytes(newBytes);
      }
      const compressOptions = { level: options?.zstdLevel ?? 3 };
      if (cancelled) {
        return;
      }

      const delta = await encodeDeltaBytes(old, target);
      const deltaZ = await compress(delta, compressOptions);

      let algo: FrameAlgo = FrameAlgo.GdeltaZstd;
      let winner = deltaZ;

      if (options?.fallback !== false && !cancelled) {
        const fullZ = await compress(target, compressOptions);
        const candidates: ReadonlyArray<[FrameAlgo, Uint8Array]> = [
          [FrameAlgo.GdeltaZstd, deltaZ],
          [FrameAlgo.FullZstd, fullZ],
          [FrameAlgo.GdeltaRaw, delta],
          [FrameAlgo.RawFull, target],
        ];
        for (const [candidateAlgo, candidateBody] of candidates) {
          if (candidateBody.length < winner.length) {
            algo = candidateAlgo;
            winner = candidateBody;
          }
        }
      }

      if (!cancelled) {
        header = frameHeader(algo);
        body = winner;
      }
    },
    pull(controller) {
      if (!headerSent) {
        headerSent = true;
        controller.enqueue(header as Uint8Array);
        if ((body as Uint8Array).length === 0) {
          controller.close();
        }
        return;
      }
      const bytes = body as Uint8Array;
      controller.enqueue(bytes.subarray(offset, offset + CHUNK));
      offset += CHUNK;
      if (offset >= bytes.length) {
        controller.close();
      }
    },
    async cancel(reason) {
      cancelled = true;
      header = undefined;
      body = undefined;
      // Release a streamed `new` source that is still being buffered.
      await source?.cancel(reason);
    },
  });
}

/**
 * One-shot convenience over {@link encodeFramed}.
 */
export function encodeFramedBytes(
  old: Uint8Array | ArrayBuffer,
  newBytes: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
  options?: FramedEncodeOptions,
): Promise<Uint8Array> {
  return collect(encodeFramed(old, newBytes, options));
}
