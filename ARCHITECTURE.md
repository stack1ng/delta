# Architecture

## Seams

```
src/gdelta/encode.ts   → wasm/gdelta_encode.wasm    (~19 KB)
src/gdelta/decode.ts   → wasm/gdelta_decode.wasm    (~16 KB)
src/zstd/compress.ts   → wasm/zstd_compress.wasm    (~235 KB)
src/zstd/decompress.ts → wasm/zstd_decompress.wasm  (~71 KB)
src/pipeline/index.ts  → imports the four entries above; no fused wasm
src/index.ts           → convenience re-exports only
src/internal/          → wasm loader, byte helpers, codec pump; no wasm refs
```

Each artifact's export section is stripped to exactly its ABI (entry
functions + `memory`/`walloc`/`wfree`) by `scripts/strip-wasm-exports.mjs`
during the build — zstd-sys' `no_mangle` shim helpers and linker globals
are dropped, which also lets `wasm-opt` DCE their code.
`tests/wasm-surface.test.ts` asserts the exact export sets.

Rules the layout enforces structurally (and `tests/isolation.test.ts` gates):

- gdelta modules never import zstd modules and vice versa; the pipeline is
  the only composer.
- Each entry references exactly one `.wasm` asset via
  `new URL(..., import.meta.url)`; importing decode cannot load encode wasm.
- All modules are side-effect-free ESM (`sideEffects: false`); wasm loads
  lazily on first call, or eagerly via each entry's exported `init()`.

## Why encode/decode wasm are split

They share almost no code. GDelta decode is an instruction interpreter — it
needs neither the GEAR hash table (2 KB of constants) nor the match-finding
code, so the decode artifact is ~25% smaller and a decode-only consumer
(e.g. a client applying server patches) ships no encoder. For zstd the
asymmetry is larger: libzstd's decompressor is about a third of the size of
the compressor. Rust-side, each `crates/*-wasm` cdylib exports only its
direction's symbols and LTO strips the rest.

## What can and cannot stream

| Operation | Input | Output |
|---|---|---|
| gdelta encode | full `old` + full `new` required (random access; algorithm inherent). A `ReadableStream` for `new` is accepted but fully buffered — documented, not hidden. | Delta is materialized once in wasm memory (the wire format length-prefixes the instruction block, so no bytes are final until encode completes), then emitted in 64 KB chunks with backpressure. |
| gdelta decode | full `old` required; delta consumed sequentially in arbitrary chunks. | Truly incremental. The wasm decoder buffers only the instruction block (small, proportional to instruction count) plus literal bytes that arrived but were not yet emitted. Copy output reads straight from the base. |
| zstd compress | streaming (`ZSTD_compressStream2`). | streaming. |
| zstd decompress | streaming (`ZSTD_decompressStream`). | streaming. |
| pipeline encode | buffers `new` and candidate bodies to pick the smallest frame (see FRAME.md). | streams the chosen frame out. |
| pipeline decode | fully streaming: header → zstd transform → gdelta decoder. | streaming. |

Copy discipline: each input chunk is copied into wasm memory once, each
output chunk is copied out once (wasm memory is not shareable with JS
buffers, so these two copies are the floor). The library never concatenates
or re-buffers between those points.

## Backpressure

Everything that produces output is pull-driven and emits at most one
bounded (≤64 KiB) chunk per pull, so no path can run ahead of downstream
demand:

- The zstd entries return a `{ readable, writable }` pair built on the
  shared pump in `src/internal/pump.ts` rather than a `TransformStream`.
  A TransformStream's `transform()` must emit everything an input chunk
  produces before the next write is accepted — spec backpressure is
  between chunks, not within one — so a few hundred compressed bytes that
  expand to megabytes would be queued wholesale. In the pump, the codec
  only advances inside `pull()`, and a pending `write()` resolves only
  once its chunk is fully consumed *and* drained: a decompression bomb
  leaves the writer stalled while the consumer is idle, holding at most
  one chunk in flight.
- gdelta decode reads more delta input only when the wasm decoder has
  nothing left to emit, so copy-amplified output (one small COPY
  instruction expanding to megabytes from the base) is likewise
  reconstructed strictly on demand.
- gdelta encode emits the materialized delta chunk-per-pull.

For callers that know the expected size, every decode direction also takes
`maxOutputBytes` — a hard cap on total reconstructed output (and a derived
cap on buffered patch input) that turns resource-exhaustion inputs into
prompt errors.

## WASM memory behavior

Each entry instantiates its module once per process (lazily) and shares it
across concurrent streams; per-stream state lives in per-context
allocations. `WebAssembly.Memory` grows on demand (input/output scratch
buffers, decoder state, encoder hash table) and — per wasm semantics —
never shrinks back. Peak usage follows the largest payload processed. If
that matters (e.g. one-off huge snapshots in a long-lived worker), isolate
the work in a fresh worker or accept the high-water mark.

## Toolchain

Nix pins tools (rust + wasm32 target via rust-overlay, clang for libzstd's C
sources, binaryen, bun, node, biome); Bun's lockfile pins JS packages.
`nix develop` then `bun install && bun run ci` is the whole setup. The zstd
crates compile libzstd 1.5.7 (vendored by `zstd-sys`) with its wasm shim;
Apple clang cannot target wasm32, hence the pinned LLVM in the devshell.
