/**
 * Zstd streaming compression. Loads only `zstd_compress.wasm`.
 *
 * The wasm side is a direct wrapper over `ZSTD_compressStream2`; each input
 * chunk is copied into wasm memory once, compressed, and compressed bytes
 * are copied out once per output chunk. Output is produced one bounded
 * chunk per downstream pull (see `internal/pump.ts` for the backpressure
 * contract), so the returned pair — plug-compatible with `pipeThrough` —
 * never queues output the consumer has not asked for.
 */

import { bundledWasm } from "#wasm/zstd_compress";
import { bytesToStream, collect, requireBytes } from "../internal/bytes.js";
import { codecPair, type PumpCodec } from "../internal/pump.js";
import { type BaseWasmExports, lazyWasm, type WasmSource } from "../internal/wasm.js";

interface ZstdCompressExports extends BaseWasmExports {
  zstd_comp_new(level: number): number;
  zstd_comp_transform(
    ctx: number,
    inPtr: number,
    inLen: number,
    inPos: number,
    outPtr: number,
    outCap: number,
  ): bigint;
  zstd_comp_end(ctx: number, outPtr: number, outCap: number): bigint;
  zstd_comp_free(ctx: number): void;
}

const wasm = /* @__PURE__ */ lazyWasm<ZstdCompressExports>(
  () => new URL("../../wasm/zstd_compress.wasm", import.meta.url),
  ["zstd_comp_new", "zstd_comp_transform", "zstd_comp_end", "zstd_comp_free"],
  bundledWasm,
);

/**
 * Pre-initializes this entry's wasm module, optionally from an explicit
 * source (bytes, module, Response, or URL) for runtimes where neither `fs`
 * nor `fetch` can reach the packaged `.wasm` file.
 */
export function init(source?: WasmSource): Promise<void> {
  return wasm.init(source);
}

export interface CompressOptions {
  /** Zstd compression level (default 3, libzstd's default). */
  level?: number;
}

// libzstd's real range for the vendored 1.5.7: ZSTD_minCLevel() = -131072,
// ZSTD_maxCLevel() = 22. Anything outside would silently wrap through the
// i32 ABI, so reject it here.
const MIN_LEVEL = -131072;
const MAX_LEVEL = 22;

function validateLevel(value: number | undefined): number {
  if (value === undefined) {
    return 3;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_LEVEL ||
    value > MAX_LEVEL
  ) {
    throw new TypeError(`level must be an integer in [${MIN_LEVEL}, ${MAX_LEVEL}]`);
  }
  return value;
}

/**
 * Creates a compression stream pair: uncompressed chunks in, one zstd frame
 * out. Use with `pipeThrough`, or drive `writable`/`readable` directly.
 */
export function compressTransform(
  options?: CompressOptions,
): ReadableWritablePair<Uint8Array, Uint8Array> {
  const level = validateLevel(options?.level);
  const codec: PumpCodec<ZstdCompressExports> = {
    exports: () => wasm.exports(),
    create: (e) => e.zstd_comp_new(level),
    createError: `zstd: failed to create compression context (level ${level})`,
    step: (e, ctx, inPtr, inLen, inPos, outPtr, outCap) =>
      e.zstd_comp_transform(ctx, inPtr, inLen, inPos, outPtr, outCap),
    stepError: "zstd: compression failed",
    end: (e, ctx, outPtr, outCap) => {
      const packed = e.zstd_comp_end(ctx, outPtr, outCap);
      if (packed < 0n) {
        throw new Error("zstd: failed to finalize frame");
      }
      return {
        produced: Number(packed & 0xffffffffn),
        done: Number(packed >> 32n) === 0,
      };
    },
    free: (e, ctx) => e.zstd_comp_free(ctx),
  };
  return codecPair(codec);
}

/**
 * One-shot convenience over {@link compressTransform}.
 */
export function compress(bytes: Uint8Array, options?: CompressOptions): Promise<Uint8Array> {
  requireBytes(bytes);
  return collect(bytesToStream(bytes).pipeThrough(compressTransform(options)));
}
