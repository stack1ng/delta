/**
 * GDelta encode. Loads only `gdelta_encode.wasm`.
 *
 * Streaming honesty: GDelta encode requires random access to the full `old`
 * buffer and the full `new` buffer — that is inherent to the algorithm. If
 * `newBytes` is passed as a stream it is fully buffered before encoding.
 * The delta wire format is length-prefixed, so the delta itself is only
 * known once encode completes; the returned stream then emits it in chunks
 * (with backpressure) straight out of wasm memory.
 */

import { asBytes, collect } from "../internal/bytes.js";
import {
  type BaseWasmExports,
  copyIn,
  copyOut,
  lazyWasm,
  type WasmSource,
} from "../internal/wasm.js";

interface GdeltaEncodeExports extends BaseWasmExports {
  gdelta_encode(newPtr: number, newLen: number, basePtr: number, baseLen: number): number;
  gdelta_result_ptr(handle: number): number;
  gdelta_result_len(handle: number): number;
  gdelta_result_free(handle: number): void;
}

const wasm = lazyWasm<GdeltaEncodeExports>(
  new URL("../../wasm/gdelta_encode.wasm", import.meta.url),
);

/**
 * Pre-initializes this entry's wasm module, optionally from an explicit
 * source (bytes, module, Response, or URL).
 */
export function init(source?: WasmSource): Promise<void> {
  return wasm.init(source);
}

const CHUNK = 64 * 1024;

/**
 * Encodes the delta that transforms `old` into `newBytes`, returned as a
 * stream of raw gdelta patch bytes (no compression).
 *
 * `old` must be a full buffer (the algorithm needs random access to all of
 * it). A streamed `newBytes` is fully buffered internally before encoding.
 */
export function encodeDelta(
  old: Uint8Array | ArrayBuffer,
  newBytes: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const oldBytes = asBytes(old);
  if (!(newBytes instanceof ReadableStream)) {
    newBytes = asBytes(newBytes);
  }

  let exports: GdeltaEncodeExports;
  let cancelled = false;
  let handle = 0;
  let resultPtr = 0;
  let resultLen = 0;
  let offset = 0;

  function dispose(): void {
    if (handle !== 0) {
      exports.gdelta_result_free(handle);
      handle = 0;
    }
  }

  return new ReadableStream<Uint8Array>({
    async start() {
      const target =
        newBytes instanceof ReadableStream ? await collect(newBytes) : (newBytes as Uint8Array);

      exports = await wasm.exports();
      if (cancelled) {
        // Cancelled while buffering or loading (the spec runs cancel
        // immediately, not after start settles): encode nothing.
        return;
      }
      const basePtr = oldBytes.length > 0 ? exports.walloc(oldBytes.length) : 0;
      if (basePtr !== 0) {
        copyIn(exports.memory, basePtr, oldBytes);
      }
      const newPtr = target.length > 0 ? exports.walloc(target.length) : 0;
      if (newPtr !== 0) {
        copyIn(exports.memory, newPtr, target);
      }

      handle = exports.gdelta_encode(newPtr, target.length, basePtr, oldBytes.length);

      if (newPtr !== 0) {
        exports.wfree(newPtr, target.length);
      }
      if (basePtr !== 0) {
        exports.wfree(basePtr, oldBytes.length);
      }

      resultPtr = exports.gdelta_result_ptr(handle);
      resultLen = exports.gdelta_result_len(handle);
    },
    pull(controller) {
      if (offset >= resultLen) {
        dispose();
        controller.close();
        return;
      }
      const len = Math.min(CHUNK, resultLen - offset);
      controller.enqueue(copyOut(exports.memory, resultPtr + offset, len));
      offset += len;
      if (offset >= resultLen) {
        dispose();
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
      dispose();
    },
  });
}

/**
 * One-shot convenience over {@link encodeDelta}: returns the whole delta as
 * a single buffer.
 */
export function encodeDeltaBytes(
  old: Uint8Array | ArrayBuffer,
  newBytes: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  return collect(encodeDelta(old, newBytes));
}
