/**
 * Framed pipeline: gdelta encode → zstd compress on encode, and the reverse
 * on decode, behind a small versioned wire frame so algorithms stay
 * swappable. The pipeline is the only place gdelta and zstd compose; the
 * per-algorithm entries never import each other.
 *
 * This module re-exports both directions for convenience. Import
 * `@stack1ng/delta/pipeline/encode` or `/pipeline/decode` directly when
 * only one direction should reach the bundle — each pulls only its own
 * side's wasm. See FRAME.md for the byte-level frame layout.
 */

export { decodeFramed, decodeFramedBytes, type FramedDecodeOptions } from "./decode.js";
export { encodeFramed, encodeFramedBytes, type FramedEncodeOptions } from "./encode.js";
export { FRAME_MAGIC, FRAME_VERSION, FrameAlgo } from "./frame.js";
