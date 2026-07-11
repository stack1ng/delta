/**
 * Convenience root that re-exports the documented surface.
 *
 * Wasm instantiation is lazy (first call), so importing this module runs no
 * wasm by itself; with a tree-shaking bundler unused entries disappear
 * entirely. For guaranteed-minimal bundles import the subpaths directly,
 * e.g. `@stack1ng/delta/gdelta/decode`.
 */

export {
  type DecodeDeltaOptions,
  decodeDelta,
  decodeDeltaBytes,
  init as initGdeltaDecode,
} from "./gdelta/decode.js";
export {
  encodeDelta,
  encodeDeltaBytes,
  init as initGdeltaEncode,
} from "./gdelta/encode.js";
export type { WasmSource } from "./internal/wasm.js";
export {
  decodeFramed,
  decodeFramedBytes,
  encodeFramed,
  encodeFramedBytes,
  FRAME_MAGIC,
  FRAME_VERSION,
  FrameAlgo,
  type FramedDecodeOptions,
  type FramedEncodeOptions,
} from "./pipeline/index.js";
export {
  type CompressOptions,
  compress,
  compressTransform,
  init as initZstdCompress,
} from "./zstd/compress.js";
export {
  type DecompressOptions,
  decompress,
  decompressTransform,
  init as initZstdDecompress,
} from "./zstd/decompress.js";
