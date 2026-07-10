# Frame format

Versioned wire frame produced by `@stack1ng/delta/pipeline`. All multi-byte
concepts are single bytes here; there is no endianness to worry about.

## Layout (version 1)

| Offset | Size | Field | Value |
|---|---|---|---|
| 0 | 1 | magic[0] | `0x44` (`D`) |
| 1 | 1 | magic[1] | `0x46` (`F`) |
| 2 | 1 | version | `0x01` |
| 3 | 1 | algorithm | see below |
| 4 | … | body | algorithm-dependent |

## Algorithms

| Id | Name | Body | Decode path |
|---|---|---|---|
| `0x00` | raw-full | `new` bytes verbatim | passthrough |
| `0x01` | gdelta-raw | raw gdelta patch | gdelta.decode(old) |
| `0x02` | full-zstd | zstd frame of `new` | zstd.decompress |
| `0x03` | gdelta-zstd | zstd frame of the gdelta patch | zstd.decompress → gdelta.decode(old) |

`gdelta-zstd` (`0x03`) is the primary product path. The others exist so the
encoder can always send the smallest candidate:

- `full-zstd` / `raw-full` — fallback when the payloads are too dissimilar
  for a delta to help (a fresh client, a corrupted base, unrelated data).
  Decode ignores `old` entirely for these.
- `gdelta-raw` — small payloads where the zstd frame overhead (~13 bytes)
  exceeds its savings.

## Encoder selection policy

With `fallback: true` (default), the encoder materializes the gdelta patch,
compresses it, additionally compresses the full `new` bytes, and emits the
smallest of the four candidates. This costs one extra zstd pass over `new`.
With `fallback: false` the frame is always `gdelta-zstd` and `new` is never
compressed on its own.

Ties favor the earlier candidate in the order
`gdelta-zstd, full-zstd, gdelta-raw, raw-full`.

## Versioning

Bumping `version` invalidates all fields after offset 2. Decoders reject
unknown versions and unknown algorithm ids. New algorithm ids may be added
within version 1; decoders reject ids they do not know.
