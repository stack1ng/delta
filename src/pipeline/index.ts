/**
 * Framed pipeline: gdelta encode → zstd compress on encode, and the reverse
 * on decode, behind a small versioned wire frame so algorithms stay
 * swappable. This module is the only place gdelta and zstd compose; the
 * per-algorithm entries never import each other.
 *
 * See FRAME.md for the byte-level layout.
 */

import { decodeDelta } from "../gdelta/decode.js";
import { encodeDeltaBytes } from "../gdelta/encode.js";
import { asBytes, bytesToStream, collect, concat, requireBytes } from "../internal/bytes.js";
import { compress } from "../zstd/compress.js";
import { decompressTransform } from "../zstd/decompress.js";

/** Frame magic: ASCII "DF". */
export const FRAME_MAGIC: readonly [number, number] = [0x44, 0x46];

/** Current frame version. */
export const FRAME_VERSION = 0x01;

/** Frame body encodings. */
export const FrameAlgo = {
  /** `new` bytes verbatim (tiny payloads where any encoding adds overhead). */
  RawFull: 0x00,
  /** Raw gdelta patch bytes. */
  GdeltaRaw: 0x01,
  /** Zstd frame of the full `new` bytes (fallback when a delta won't help). */
  FullZstd: 0x02,
  /** Zstd frame of the gdelta patch bytes — the primary product path. */
  GdeltaZstd: 0x03,
} as const;

export type FrameAlgo = (typeof FrameAlgo)[keyof typeof FrameAlgo];

const HEADER_LEN = 4;

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

export interface FramedDecodeOptions {
  /**
   * Rejects the stream once reconstructed output would exceed this many
   * bytes. Intermediate stages get proportional bounds (a valid gdelta
   * patch needs at most ~2 bytes per output byte plus overhead), so memory
   * stays bounded even for adversarial frames.
   */
  maxOutputBytes?: number;
}

function frame(algo: FrameAlgo, body: Uint8Array): Uint8Array {
  const framed = new Uint8Array(HEADER_LEN + body.length);
  framed[0] = FRAME_MAGIC[0];
  framed[1] = FRAME_MAGIC[1];
  framed[2] = FRAME_VERSION;
  framed[3] = algo;
  framed.set(body, HEADER_LEN);
  return framed;
}

/**
 * Encodes `old → new` as a framed wire payload.
 *
 * Both inputs end up fully buffered — gdelta encode inherently needs full
 * random access to both, and candidate selection needs candidate sizes — so
 * this facade trades streaming input for the smallest wire size. The result
 * streams out.
 */
export function encodeFramed(
  old: Uint8Array | ArrayBuffer,
  newBytes: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
  options?: FramedEncodeOptions,
): ReadableStream<Uint8Array> {
  let inner: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async start() {
      const target =
        newBytes instanceof ReadableStream ? await collect(newBytes) : asBytes(newBytes);
      const compressOptions = { level: options?.zstdLevel ?? 3 };
      if (cancelled) {
        return;
      }

      const delta = await encodeDeltaBytes(old, target);
      const deltaZ = await compress(delta, compressOptions);

      let algo: FrameAlgo = FrameAlgo.GdeltaZstd;
      let body = deltaZ;

      if (options?.fallback !== false && !cancelled) {
        const fullZ = await compress(target, compressOptions);
        const candidates: ReadonlyArray<[FrameAlgo, Uint8Array]> = [
          [FrameAlgo.GdeltaZstd, deltaZ],
          [FrameAlgo.FullZstd, fullZ],
          [FrameAlgo.GdeltaRaw, delta],
          [FrameAlgo.RawFull, target],
        ];
        for (const [candidateAlgo, candidateBody] of candidates) {
          if (candidateBody.length < body.length) {
            algo = candidateAlgo;
            body = candidateBody;
          }
        }
      }

      if (!cancelled) {
        inner = bytesToStream(frame(algo, body)).getReader();
      }
    },
    async pull(controller) {
      const { done, value } = await (inner as ReadableStreamDefaultReader<Uint8Array>).read();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      cancelled = true;
      return inner?.cancel(reason);
    },
  });
}

interface SplitStream {
  prefix: Uint8Array;
  rest: ReadableStream<Uint8Array>;
}

async function readPrefix(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  n: number,
): Promise<SplitStream> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < n) {
    const { done, value } = await reader.read();
    if (done) {
      throw new Error(`delta-frame: input shorter than ${n}-byte header`);
    }
    requireBytes(value);
    chunks.push(value);
    total += value.length;
  }
  const all = concat(chunks, total);
  const leftover = all.subarray(n);
  const rest = new ReadableStream<Uint8Array>({
    start(controller) {
      if (leftover.length > 0) {
        controller.enqueue(leftover);
      }
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { prefix: all.subarray(0, n), rest };
}

/**
 * Decodes a framed wire payload back into `new`, fully streaming: the frame
 * body is decompressed and/or delta-decoded incrementally, one bounded
 * chunk per downstream pull.
 */
export function decodeFramed(
  old: Uint8Array | ArrayBuffer,
  framed: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
  options?: FramedDecodeOptions,
): ReadableStream<Uint8Array> {
  const framedStream = framed instanceof ReadableStream ? framed : bytesToStream(asBytes(framed));
  const maxOutputBytes = options?.maxOutputBytes ?? Number.POSITIVE_INFINITY;
  if (Number.isNaN(maxOutputBytes) || maxOutputBytes < 0) {
    throw new TypeError("maxOutputBytes must be a non-negative number");
  }
  const capped = maxOutputBytes !== Number.POSITIVE_INFINITY;
  // A valid gdelta patch is bounded by ~2 bytes per output byte plus
  // instruction overhead; the intermediate stages get that much headroom.
  const deltaCap = { maxOutputBytes: 2 * maxOutputBytes + 65536 };
  const outputCap = { maxOutputBytes };

  let sourceReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let inner: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  let totalOut = 0;

  return new ReadableStream<Uint8Array>({
    async start() {
      // Acquire the source reader up front so cancel() always has a valid
      // target — cancelling the locked framedStream itself would throw.
      sourceReader = framedStream.getReader();
      try {
        const { prefix, rest } = await readPrefix(sourceReader, HEADER_LEN);
        if (cancelled) {
          // Cancelled while reading the header (the spec runs cancel
          // immediately, not after start settles): build no inner stage.
          return;
        }
        if (prefix[0] !== FRAME_MAGIC[0] || prefix[1] !== FRAME_MAGIC[1]) {
          throw new Error("delta-frame: bad magic");
        }
        if (prefix[2] !== FRAME_VERSION) {
          throw new Error(`delta-frame: unsupported version ${prefix[2]}`);
        }
        switch (prefix[3]) {
          case FrameAlgo.RawFull:
            inner = rest.getReader();
            break;
          case FrameAlgo.GdeltaRaw:
            inner = decodeDelta(old, rest, capped ? outputCap : undefined).getReader();
            break;
          case FrameAlgo.FullZstd:
            inner = rest
              .pipeThrough(decompressTransform(capped ? outputCap : undefined))
              .getReader();
            break;
          case FrameAlgo.GdeltaZstd:
            inner = decodeDelta(
              old,
              rest.pipeThrough(decompressTransform(capped ? deltaCap : undefined)),
              capped ? outputCap : undefined,
            ).getReader();
            break;
          default:
            throw new Error(`delta-frame: unknown algorithm ${prefix[3]}`);
        }
      } catch (error) {
        try {
          await sourceReader.cancel(error);
        } catch {
          // The source may already be errored.
        }
        throw error;
      }
    },
    async pull(controller) {
      const reader = inner as ReadableStreamDefaultReader<Uint8Array>;
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      // Central validation and cap for the RawFull passthrough; the decoded
      // paths enforce their own before bytes ever reach this point.
      requireBytes(value);
      totalOut += value.length;
      if (totalOut > maxOutputBytes) {
        const error = new Error(`output exceeds maxOutputBytes (${maxOutputBytes})`);
        try {
          await reader.cancel(error);
        } catch {
          // Already errored upstream.
        }
        throw error;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      cancelled = true;
      // Cancelling `inner` propagates through the decode stages to the
      // source; before the inner stage exists, cancel the source reader
      // directly (never framedStream itself — it is locked by that reader).
      if (inner !== undefined) {
        return inner.cancel(reason);
      }
      return sourceReader?.cancel(reason).catch(() => {});
    },
  });
}

/**
 * One-shot convenience over {@link decodeFramed}.
 */
export function decodeFramedBytes(
  old: Uint8Array | ArrayBuffer,
  framed: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
  options?: FramedDecodeOptions,
): Promise<Uint8Array> {
  return collect(decodeFramed(old, framed, options));
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
