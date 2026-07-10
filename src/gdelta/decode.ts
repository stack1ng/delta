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

import {
  asBytes,
  bytesToStream,
  collect,
  requireBytes,
  validateByteCap,
} from "../internal/bytes.js";
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

const wasm = /* @__PURE__ */ lazyWasm<GdeltaDecodeExports>(
  new URL("../../wasm/gdelta_decode.wasm", import.meta.url),
  [
    "gdelta_decoder_new",
    "gdelta_decoder_push",
    "gdelta_decoder_read",
    "gdelta_decoder_finish",
    "gdelta_decoder_free",
  ],
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
   * bytes. Output-only: valid patches can legitimately be much larger than
   * their output (fragmented copies, zero-length instructions), so no input
   * bound is derived from this — use {@link maxPatchBytes} for that.
   */
  maxOutputBytes?: number;
  /**
   * Rejects the stream once the delta itself exceeds this many bytes.
   * This is the decoder's memory bound: it buffers the instruction block
   * (≤ the patch size) plus not-yet-emitted literal bytes.
   */
  maxPatchBytes?: number;
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
  const maxOutputBytes = validateByteCap(options?.maxOutputBytes, "maxOutputBytes");
  const maxPatchBytes = validateByteCap(options?.maxPatchBytes, "maxPatchBytes");
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

  /** Best-effort, at-most-once — a throwing free must not stop the rest. */
  function dispose(): void {
    if (exports === undefined) {
      return;
    }
    const e = exports;
    const liveCtx = ctx;
    ctx = 0;
    if (liveCtx !== 0) {
      try {
        e.gdelta_decoder_free(liveCtx);
      } catch {}
    }
    // The decoder borrows the base; free it only after the decoder is gone.
    const liveBase = basePtr;
    basePtr = 0;
    if (liveBase !== 0) {
      try {
        e.wfree(liveBase, baseLen);
      } catch {}
    }
    const liveIn = inPtr;
    inPtr = 0;
    if (liveIn !== 0) {
      try {
        e.wfree(liveIn, inCap);
      } catch {}
    }
    const liveOut = outPtr;
    outPtr = 0;
    if (liveOut !== 0) {
      try {
        e.wfree(liveOut, OUT_CAP);
      } catch {}
    }
  }

  async function abandonSource(reason: unknown): Promise<void> {
    // Claim the reader before awaiting (the local-ownership rule): a pull
    // failure and a consumer cancel can both get here, and the second
    // entrant must see no owned reader rather than re-cancel or touch a
    // variable the first entrant clears mid-await.
    const owned = reader;
    reader = undefined;
    if (owned !== undefined) {
      try {
        await owned.cancel(reason);
      } catch {
        // The source may already be errored; nothing left to release.
      }
      owned.releaseLock();
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
        if (baseLen > 0 && basePtr === 0) {
          throw new Error("wasm memory exhausted");
        }
        if (basePtr !== 0) {
          copyIn(exports.memory, basePtr, oldBytes);
        }
        ctx = exports.gdelta_decoder_new(basePtr, baseLen);
        outPtr = exports.walloc(OUT_CAP);
        if (outPtr === 0) {
          throw new Error("wasm memory exhausted");
        }
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
          // pull again while downstream demand remains. Instructions parse
          // lazily inside the decoder, so malformed/out-of-bounds units
          // surface here as negative codes.
          const n = exports.gdelta_decoder_read(ctx, outPtr, OUT_CAP);
          if (n < 0) {
            throw decodeError(n);
          }
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
          if (totalIn > maxPatchBytes) {
            throw new Error(`delta exceeds maxPatchBytes (${maxPatchBytes})`);
          }
          if (value.length > inCap) {
            // Claim the old pointer before freeing (a throwing wfree is
            // never retried by dispose) and record the new pointer before
            // the copy below, so the outer catch reclaims it exactly once.
            const oldPtr = inPtr;
            const oldCap = inCap;
            inPtr = 0;
            inCap = 0;
            if (oldPtr !== 0) {
              exports.wfree(oldPtr, oldCap);
            }
            const cap = Math.max(value.length, MIN_IN_CAP);
            const ptr = exports.walloc(cap);
            if (ptr === 0) {
              throw new Error("wasm memory exhausted");
            }
            inPtr = ptr;
            inCap = cap;
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
