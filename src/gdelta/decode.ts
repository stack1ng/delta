/**
 * GDelta decode. Loads only `gdelta_decode.wasm`.
 *
 * Decode needs random access to the full `old` buffer (copy instructions),
 * but consumes the delta sequentially and emits output incrementally: the
 * wasm decoder buffers only the (small) instruction block plus literal bytes
 * that have arrived but not yet been emitted.
 *
 * Backpressure: the returned stream emits exactly one bounded chunk per
 * pull and only reads more delta input when the decoder has nothing left to
 * emit, so a small delta that expands to a large output (one big COPY) is
 * reconstructed strictly on downstream demand.
 */

import { asBytes, bytesToStream, collect, requireBytes } from "../internal/bytes.js";
import {
  type BaseWasmExports,
  copyIn,
  copyOut,
  lazyWasm,
  type WasmSource,
} from "../internal/wasm.js";

interface GdeltaDecodeExports extends BaseWasmExports {
  gdelta_decoder_new(basePtr: number, baseLen: number): number;
  gdelta_decoder_push(ctx: number, ptr: number, len: number): number;
  gdelta_decoder_read(ctx: number, outPtr: number, outCap: number): number;
  gdelta_decoder_finish(ctx: number): number;
  gdelta_decoder_free(ctx: number): void;
}

const wasm = lazyWasm<GdeltaDecodeExports>(
  new URL("../../wasm/gdelta_decode.wasm", import.meta.url),
);

/**
 * Pre-initializes this entry's wasm module, optionally from an explicit
 * source (bytes, module, Response, or URL).
 */
export function init(source?: WasmSource): Promise<void> {
  return wasm.init(source);
}

export interface DecodeDeltaOptions {
  /**
   * Rejects the stream once reconstructed output would exceed this many
   * bytes. Also bounds the delta bytes buffered by the decoder (a valid
   * delta needs at most ~2 bytes of input per output byte plus instruction
   * overhead, so the input bound is derived as `2 * maxOutputBytes + 64Ki`).
   */
  maxOutputBytes?: number;
}

const OUT_CAP = 64 * 1024;
const MIN_IN_CAP = 64 * 1024;

function decodeError(code: number): Error {
  switch (code) {
    case -1:
      return new Error("gdelta: truncated delta");
    case -2:
      return new Error("gdelta: malformed delta");
    case -3:
      return new Error("gdelta: copy instruction out of base bounds");
    case -4:
      return new Error("gdelta: trailing bytes after delta");
    default:
      return new Error(`gdelta: decode failed (code ${code})`);
  }
}

/**
 * Reconstructs `new` from `old` and a delta, as a stream.
 *
 * `old` must be a full buffer; the delta may arrive in arbitrary chunks.
 */
export function decodeDelta(
  old: Uint8Array | ArrayBuffer,
  delta: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
  options?: DecodeDeltaOptions,
): ReadableStream<Uint8Array> {
  const oldBytes = asBytes(old);
  const maxOutputBytes = options?.maxOutputBytes ?? Number.POSITIVE_INFINITY;
  if (Number.isNaN(maxOutputBytes) || maxOutputBytes < 0) {
    throw new TypeError("maxOutputBytes must be a non-negative number");
  }
  const maxInputBytes =
    maxOutputBytes === Number.POSITIVE_INFINITY ? maxOutputBytes : 2 * maxOutputBytes + 65536;
  const deltaStream = delta instanceof ReadableStream ? delta : bytesToStream(asBytes(delta));

  let exports: GdeltaDecodeExports;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  let ctx = 0;
  let basePtr = 0;
  let baseLen = 0;
  let inPtr = 0;
  let inCap = 0;
  let outPtr = 0;
  let totalIn = 0;
  let totalOut = 0;

  function dispose(): void {
    if (exports === undefined) {
      return;
    }
    if (ctx !== 0) {
      exports.gdelta_decoder_free(ctx);
      ctx = 0;
    }
    // The decoder borrows the base; free it only after the decoder is gone.
    if (basePtr !== 0) {
      exports.wfree(basePtr, baseLen);
      basePtr = 0;
    }
    if (inPtr !== 0) {
      exports.wfree(inPtr, inCap);
      inPtr = 0;
    }
    if (outPtr !== 0) {
      exports.wfree(outPtr, OUT_CAP);
      outPtr = 0;
    }
  }

  async function abandonSource(reason: unknown): Promise<void> {
    if (reader !== undefined) {
      try {
        await reader.cancel(reason);
      } catch {
        // The source may already be errored; nothing left to release.
      }
      reader.releaseLock();
      reader = undefined;
    }
  }

  return new ReadableStream<Uint8Array>({
    async start() {
      try {
        exports = await wasm.exports();
        if (cancelled) {
          // Cancelled while the module was loading (the spec runs cancel
          // immediately, not after start settles): allocate nothing. The
          // cancel handler already dealt with the source stream.
          return;
        }
        baseLen = oldBytes.length;
        basePtr = baseLen > 0 ? exports.walloc(baseLen) : 0;
        if (basePtr !== 0) {
          copyIn(exports.memory, basePtr, oldBytes);
        }
        ctx = exports.gdelta_decoder_new(basePtr, baseLen);
        outPtr = exports.walloc(OUT_CAP);
        reader = deltaStream.getReader();
      } catch (error) {
        dispose();
        throw error;
      }
    },
    async pull(controller) {
      try {
        for (;;) {
          // Emit at most one chunk per pull; the stream machinery calls
          // pull again while downstream demand remains.
          const n = exports.gdelta_decoder_read(ctx, outPtr, OUT_CAP);
          if (n > 0) {
            totalOut += n;
            if (totalOut > maxOutputBytes) {
              throw new Error(`output exceeds maxOutputBytes (${maxOutputBytes})`);
            }
            controller.enqueue(copyOut(exports.memory, outPtr, n));
            return;
          }

          // Nothing to emit: the decoder needs more delta input.
          const { done, value } = await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
          if (ctx === 0) {
            // Cancelled while awaiting input: the context is already freed
            // and the stream discarded; do not touch the decoder again.
            return;
          }
          if (done) {
            const code = exports.gdelta_decoder_finish(ctx);
            if (code !== 0) {
              throw decodeError(code);
            }
            dispose();
            reader?.releaseLock();
            reader = undefined;
            controller.close();
            return;
          }
          requireBytes(value);
          if (value.length === 0) {
            continue;
          }
          totalIn += value.length;
          if (totalIn > maxInputBytes) {
            throw new Error(
              `delta exceeds the bound implied by maxOutputBytes (${maxOutputBytes})`,
            );
          }
          if (value.length > inCap) {
            if (inPtr !== 0) {
              exports.wfree(inPtr, inCap);
            }
            inCap = Math.max(value.length, MIN_IN_CAP);
            inPtr = exports.walloc(inCap);
          }
          copyIn(exports.memory, inPtr, value);
          const code = exports.gdelta_decoder_push(ctx, inPtr, value.length);
          if (code !== 0) {
            throw decodeError(code);
          }
        }
      } catch (error) {
        dispose();
        await abandonSource(error);
        throw error;
      }
    },
    async cancel(reason) {
      cancelled = true;
      dispose();
      if (reader !== undefined) {
        await abandonSource(reason);
      } else {
        // start() has not locked the source yet (and, seeing `cancelled`,
        // never will) — cancel it directly.
        await deltaStream.cancel(reason).catch(() => {});
      }
    },
  });
}

/**
 * One-shot convenience over {@link decodeDelta}: returns the whole
 * reconstructed buffer.
 */
export function decodeDeltaBytes(
  old: Uint8Array | ArrayBuffer,
  delta: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
  options?: DecodeDeltaOptions,
): Promise<Uint8Array> {
  return collect(decodeDelta(old, delta, options));
}
