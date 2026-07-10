/**
 * Framed pipeline, decode direction: zstd decompress → gdelta decode behind
 * the versioned frame, fully streaming with one chunk per pull. Decoded
 * output (gdelta/zstd bodies) arrives in ≤64 KiB chunks; the RawFull
 * passthrough deliberately forwards source chunks at the producer's size —
 * re-chunking an already-materialized buffer would only add copies.
 * Importing only this entry pulls only the decode-side wasm (gdelta decode
 * + zstd decompress).
 *
 * Ownership: the caller's framed source is always cancelled and unlocked on
 * every terminal path — success, malformed frame, mid-body error, and
 * cancellation at any point.
 */

import { decodeDelta } from "../gdelta/decode.js";
import {
  asBytes,
  bytesToStream,
  collect,
  requireBytes,
  validateByteCap,
} from "../internal/bytes.js";
import { decompressTransform } from "../zstd/decompress.js";
import { FRAME_MAGIC, FRAME_VERSION, FrameAlgo, HEADER_LEN } from "./frame.js";

export interface FramedDecodeOptions {
  /**
   * Rejects the stream once reconstructed output would exceed this many
   * bytes. Output-only — it does not bound the patch size or the zstd
   * window; those are {@link maxPatchBytes} and {@link maxWindowBytes}.
   */
  maxOutputBytes?: number;
  /**
   * Rejects the stream once the (decompressed) gdelta patch exceeds this
   * many bytes — the memory bound for the delta stages. Valid patches can
   * legitimately exceed their output size, so this is a separate knob
   * rather than being derived from `maxOutputBytes`.
   */
  maxPatchBytes?: number;
  /**
   * Rejects frames whose declared zstd history window exceeds this many
   * bytes (checked byte-exactly against each frame header before the
   * window is allocated); see `DecompressOptions.maxWindowBytes` for why
   * this is explicit rather than derived.
   */
  maxWindowBytes?: number;
}

interface SplitStream {
  prefix: Uint8Array;
  rest: ReadableStream<Uint8Array>;
}

/**
 * Splits the first `n` bytes off a reader without copying the remainder:
 * the prefix is assembled from at most `n` bytes, the tail of the crossing
 * chunk is re-emitted as a view, and the reader lock is released whenever
 * the source ends — normally, by error, or by cancellation.
 */
async function readPrefix(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  n: number,
): Promise<SplitStream> {
  const prefix = new Uint8Array(n);
  let filled = 0;
  let leftover: Uint8Array | undefined;
  while (filled < n) {
    const { done, value } = await reader.read();
    if (done) {
      throw new Error(`delta-frame: input shorter than ${n}-byte header`);
    }
    requireBytes(value);
    const take = Math.min(n - filled, value.length);
    prefix.set(value.subarray(0, take), filled);
    filled += take;
    if (take < value.length) {
      leftover = value.subarray(take);
    }
  }
  const rest = new ReadableStream<Uint8Array>({
    start(controller) {
      if (leftover !== undefined && leftover.length > 0) {
        controller.enqueue(leftover);
      }
    },
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        // The source itself failed: nothing to cancel, but the lock must
        // not outlive the stream.
        reader.releaseLock();
        throw error;
      }
      if (result.done) {
        controller.close();
        reader.releaseLock();
      } else {
        controller.enqueue(result.value);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      reader.releaseLock();
    },
  });
  return { prefix, rest };
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
  const maxOutputBytes = validateByteCap(options?.maxOutputBytes, "maxOutputBytes");
  const maxPatchBytes = validateByteCap(options?.maxPatchBytes, "maxPatchBytes");
  const maxWindowBytes = validateByteCap(options?.maxWindowBytes, "maxWindowBytes");
  const outputCapped = maxOutputBytes !== Number.POSITIVE_INFINITY;
  const patchCapped = maxPatchBytes !== Number.POSITIVE_INFINITY;
  const windowCapped = maxWindowBytes !== Number.POSITIVE_INFINITY;
  const deltaOptions = {
    ...(outputCapped && { maxOutputBytes }),
    ...(patchCapped && { maxPatchBytes }),
  };
  const windowOption = windowCapped ? { maxWindowBytes } : undefined;

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
          // cancel() already cancelled and released the source reader.
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
            inner = decodeDelta(old, rest, deltaOptions).getReader();
            break;
          case FrameAlgo.FullZstd:
            inner = rest
              .pipeThrough(
                decompressTransform(
                  outputCapped || windowCapped
                    ? { ...(outputCapped && { maxOutputBytes }), ...windowOption }
                    : undefined,
                ),
              )
              .getReader();
            break;
          case FrameAlgo.GdeltaZstd:
            // The intermediate decompression yields the gdelta patch, so
            // the patch cap is the right bound for that stage.
            inner = decodeDelta(
              old,
              rest.pipeThrough(
                decompressTransform(
                  patchCapped || windowCapped
                    ? { ...(patchCapped && { maxOutputBytes: maxPatchBytes }), ...windowOption }
                    : undefined,
                ),
              ),
              deltaOptions,
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
        sourceReader.releaseLock();
        throw error;
      }
    },
    async pull(controller) {
      const reader = inner as ReadableStreamDefaultReader<Uint8Array>;
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        // Central validation and cap for the RawFull passthrough; the
        // decoded paths enforce their own before bytes ever reach here.
        requireBytes(value);
        totalOut += value.length;
        if (totalOut > maxOutputBytes) {
          throw new Error(`output exceeds maxOutputBytes (${maxOutputBytes})`);
        }
        controller.enqueue(value);
      } catch (error) {
        // Tear the chain down on any mid-body failure (invalid chunk, cap,
        // or an already-errored inner); cancelling `inner` propagates to
        // the source and releases its lock.
        await reader.cancel(error).catch(() => {});
        throw error;
      }
    },
    async cancel(reason) {
      cancelled = true;
      // Cancelling `inner` propagates through the decode stages to the
      // source; before the inner stage exists, cancel the source reader
      // directly (never framedStream itself — it is locked by that reader).
      if (inner !== undefined) {
        await inner.cancel(reason);
        return;
      }
      if (sourceReader !== undefined) {
        await sourceReader.cancel(reason).catch(() => {});
        sourceReader.releaseLock();
      }
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
