/**
 * Wire-frame constants shared by the framed encode/decode entries.
 * See FRAME.md for the byte-level layout.
 */

/** Frame magic: ASCII "DF". */
export const FRAME_MAGIC: readonly [number, number] = Object.freeze([0x44, 0x46]) as readonly [
  number,
  number,
];

/** Current frame version. */
export const FRAME_VERSION = 0x01;

/** Frame body encodings. */
export const FrameAlgo = Object.freeze({
  /** `new` bytes verbatim (tiny payloads where any encoding adds overhead). */
  RawFull: 0x00,
  /** Raw gdelta patch bytes. */
  GdeltaRaw: 0x01,
  /** Zstd frame of the full `new` bytes (fallback when a delta won't help). */
  FullZstd: 0x02,
  /** Zstd frame of the gdelta patch bytes — the primary product path. */
  GdeltaZstd: 0x03,
} as const);

export type FrameAlgo = (typeof FrameAlgo)[keyof typeof FrameAlgo];

export const HEADER_LEN = 4;

/** Builds the 4-byte frame header for `algo`. */
export function frameHeader(algo: FrameAlgo): Uint8Array {
  return Uint8Array.of(FRAME_MAGIC[0], FRAME_MAGIC[1], FRAME_VERSION, algo);
}
