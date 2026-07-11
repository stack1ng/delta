/**
 * Zstd streaming decompression. Loads only `zstd_decompress.wasm`.
 *
 * Direct wrapper over `ZSTD_decompressStream`. Output is produced one
 * bounded chunk per downstream pull (see `internal/pump.ts`), so a small
 * compressed input that expands to megabytes is decompressed strictly on
 * demand — the pending input write does not complete until the codec has
 * drained, which is what stalls a decompression bomb instead of buffering
 * it. The stream errors at end of input if the data did not end on a
 * complete frame boundary, and empty input is rejected as invalid.
 */

import { bundledWasm } from "#wasm/zstd_decompress";
import { bytesToStream, collect, requireBytes, validateByteCap } from "../internal/bytes.js";
import { codecPair, type PumpCodec } from "../internal/pump.js";
import { type BaseWasmExports, lazyWasm, type WasmSource } from "../internal/wasm.js";

interface ZstdDecompressExports extends BaseWasmExports {
  zstd_decomp_new(windowLimit: bigint): number;
  zstd_decomp_transform(
    ctx: number,
    inPtr: number,
    inLen: number,
    inPos: number,
    outPtr: number,
    outCap: number,
  ): bigint;
  zstd_decomp_done(ctx: number): number;
  zstd_decomp_free(ctx: number): void;
}

const wasm = /* @__PURE__ */ lazyWasm<ZstdDecompressExports>(
  () => new URL("../../wasm/zstd_decompress.wasm", import.meta.url),
  ["zstd_decomp_new", "zstd_decomp_transform", "zstd_decomp_done", "zstd_decomp_free"],
  bundledWasm,
);

/**
 * Pre-initializes this entry's wasm module, optionally from an explicit
 * source (bytes, module, Response, or URL).
 */
export function init(source?: WasmSource): Promise<void> {
  return wasm.init(source);
}

export interface DecompressOptions {
  /**
   * Rejects the stream once decompressed output would exceed this many
   * bytes — the caller's guard against decompression bombs when the
   * expected size is known.
   */
  maxOutputBytes?: number;
  /**
   * Rejects any frame whose header declares a history window larger than
   * this many bytes. Enforced by libzstd itself (`ZSTD_DCtx_setMaxWindowSize`)
   * byte-exactly, per frame, before the window buffer is allocated; its
   * default ceiling of 128 MiB still applies when unset. Supported range:
   * at least 1024 (libzstd's minimum window — smaller finite caps are
   * rejected as a TypeError rather than silently meaning something else).
   * Deliberately not derived from `maxOutputBytes`: streaming encoders —
   * including this library's — declare the compression level's default
   * window (e.g. 2 MiB at level 3) even for tiny payloads, so any implicit
   * derivation would reject valid frames. Set it explicitly when consuming
   * untrusted input.
   */
  maxWindowBytes?: number;
}

/** libzstd's smallest representable window; smaller caps cannot exist. */
const MIN_WINDOW_BYTES = 1024;

function validateWindowCap(value: number | undefined): bigint {
  const cap = validateByteCap(value, "maxWindowBytes");
  if (cap === Number.POSITIVE_INFINITY) {
    return 0n; // No override; unambiguous — explicit caps below are ≥ 1024.
  }
  if (cap < MIN_WINDOW_BYTES) {
    throw new TypeError(
      `maxWindowBytes must be at least ${MIN_WINDOW_BYTES} (libzstd's minimum window)`,
    );
  }
  return BigInt(cap);
}

/**
 * Creates a decompression stream pair: zstd frame chunks in, uncompressed
 * chunks out. Use with `pipeThrough`, or drive `writable`/`readable`
 * directly.
 */
export function decompressTransform(
  options?: DecompressOptions,
): ReadableWritablePair<Uint8Array, Uint8Array> {
  const windowLimit = validateWindowCap(options?.maxWindowBytes);
  const codec: PumpCodec<ZstdDecompressExports> = {
    exports: () => wasm.exports(),
    create: (e) => e.zstd_decomp_new(windowLimit),
    createError: "zstd: failed to create decompression context",
    step: (e, ctx, inPtr, inLen, inPos, outPtr, outCap) =>
      e.zstd_decomp_transform(ctx, inPtr, inLen, inPos, outPtr, outCap),
    stepError: "zstd: corrupt or unsupported data",
    stepErrorFor: (code) =>
      code === -2
        ? `zstd: frame window exceeds maxWindowBytes (${windowLimit})`
        : "zstd: corrupt or unsupported data",
    end: (e, ctx) => {
      if (e.zstd_decomp_done(ctx) !== 1) {
        throw new Error("zstd: truncated input (incomplete frame)");
      }
      return { produced: 0, done: true };
    },
    free: (e, ctx) => e.zstd_decomp_free(ctx),
    emptyInputError: "zstd: empty input is not a valid zstd stream",
    finalizesWithoutOutput: true,
  };
  return codecPair(codec, options);
}

/**
 * One-shot convenience over {@link decompressTransform}.
 */
export function decompress(bytes: Uint8Array, options?: DecompressOptions): Promise<Uint8Array> {
  requireBytes(bytes);
  return collect(bytesToStream(bytes).pipeThrough(decompressTransform(options)));
}
