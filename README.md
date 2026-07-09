# @futuralabs/delta

Low-level, tree-shakable binary delta + compression for Node and
WASM-capable bundler runtimes (Vite/Rolldown, Convex, workers).

- **GDelta** — structural binary delta (`old ↔ new → patch`,
  `patch + old → new`), ~O(n), tuned for similar 4–64 KB chunks.
- **Zstd** — general-purpose streaming compression, usable alone.
- **Framed pipeline** — the default product path: gdelta patch → zstd,
  behind a versioned 4-byte frame so algorithms stay swappable
  (see [FRAME.md](./FRAME.md)).

Bytes and Web Streams only. No string/JSON helpers, no filesystem API.
Each entrypoint loads its own small wasm binary, lazily.

## Representative numbers

JSON-ish 42 KB snapshot with scattered mutations (Apple Silicon, level 3):

| wire | size |
|---|---|
| zstd-only full snapshot | 12.7 KB |
| raw gdelta patch | 574 B |
| **framed gdelta+zstd** | **410 B** |

Encode 0.29 ms, decode 0.06 ms. Run `bun run bench` for the full table.

## Install

```sh
bun add @futuralabs/delta   # or npm/pnpm/yarn
```

Requires Node ≥ 20 (Web Streams, wasm) or any runtime with `WebAssembly`
and `fetch`/explicit `init()`.

## Entrypoints

| Import | Contents | WASM loaded |
|---|---|---|
| `@futuralabs/delta/gdelta/encode` | `encodeDelta`, `encodeDeltaBytes`, `init` | `gdelta_encode.wasm` (~19 KB) |
| `@futuralabs/delta/gdelta/decode` | `decodeDelta`, `decodeDeltaBytes`, `init` | `gdelta_decode.wasm` (~16 KB) |
| `@futuralabs/delta/zstd/compress` | `compressTransform`, `compress`, `init` | `zstd_compress.wasm` (~235 KB) |
| `@futuralabs/delta/zstd/decompress` | `decompressTransform`, `decompress`, `init` | `zstd_decompress.wasm` (~71 KB) |
| `@futuralabs/delta/pipeline` | `encodeFramed`, `decodeFramed`, `*Bytes`, frame constants | the four above, each still lazy |
| `@futuralabs/delta/wasm/*.wasm` | the raw artifacts, for bundler `?url` imports and explicit `init()` | — |
| `@futuralabs/delta` | re-exports everything (`init` renamed per algo) | none until first call |

Importing one entry never loads another entry's wasm — enforced by tests,
not just documentation. The root import is convenient; the subpaths are the
guaranteed-minimal bundles.

## Usage

### Framed pipeline (the product path)

```ts
import { encodeFramed, decodeFramed } from "@futuralabs/delta/pipeline";

// old, next: Uint8Array
const wire: ReadableStream<Uint8Array> = encodeFramed(old, next, { zstdLevel: 3 });

// … ship the bytes …

const reconstructed: ReadableStream<Uint8Array> = decodeFramed(old, wire);
```

`encodeFramed` sends the smallest of `{gdelta+zstd, full+zstd, gdelta-raw,
raw-full}`; a receiver therefore also handles fresh/unrelated payloads.
Pass `fallback: false` to always send `gdelta+zstd` and skip the extra
zstd pass over `new`.

### Zstd alone, streaming

```ts
import { compressTransform } from "@futuralabs/delta/zstd/compress";
import { decompressTransform } from "@futuralabs/delta/zstd/decompress";

const compressed = source.pipeThrough(compressTransform({ level: 3 }));
const restored = compressed.pipeThrough(decompressTransform({ maxOutputBytes: 1 << 20 }));
```

Both return a `{ readable, writable }` pair (what `pipeThrough` takes —
not a `TransformStream`, deliberately: a TransformStream must emit all
output of a chunk inside one `transform()` call, which lets a small input
that expands hugely flood the queue). Output here is produced one ≤64 KiB
chunk per downstream pull, and a pending `write()` only resolves once the
codec has fully drained that chunk — so a decompression bomb stalls
against backpressure instead of materializing.

### GDelta alone

```ts
import { encodeDelta } from "@futuralabs/delta/gdelta/encode";
import { decodeDelta } from "@futuralabs/delta/gdelta/decode";

const patch: ReadableStream<Uint8Array> = encodeDelta(old, next);
const restored: ReadableStream<Uint8Array> = decodeDelta(old, patch);
```

## Streaming limits (honest version)

- **GDelta encode needs the full `old` and the full `new`.** That is the
  algorithm, not an API choice. `old` must be a buffer; if you pass `new`
  as a stream it is **fully buffered internally** before encoding. The
  patch is length-prefixed, so it is materialized once in wasm memory and
  then streamed out in chunks.
- **GDelta decode needs the full `old`** (copy instructions address it
  randomly) but consumes the patch **sequentially** and emits output
  **incrementally** — only the small instruction block and not-yet-emitted
  literal bytes are buffered.
- **Zstd streams both directions**, both ways, with real backpressure:
  output is pulled, never pushed, so nothing decompresses ahead of demand.
- WASM memory grows with the largest payload processed and never shrinks
  (wasm semantics). See [ARCHITECTURE.md](./ARCHITECTURE.md).

## Robustness

- Stream chunks must be `Uint8Array`s; anything else rejects with a
  `TypeError` (buffer parameters accept `Uint8Array | ArrayBuffer`).
- Empty input is not a valid zstd stream and is rejected, as are truncated
  frames, corrupt data, out-of-bounds copies, and trailing bytes.
- Every decode direction takes `{ maxOutputBytes }` — a hard cap on
  reconstructed output (and, derived from it, on buffered patch input) for
  callers that know the expected size and want bombs rejected early:
  `decompress`/`decompressTransform`, `decodeDelta`/`decodeDeltaBytes`,
  and `decodeFramed`/`decodeFramedBytes` (which bounds every inner stage).

## WASM loading in bundlers / Convex

Each entry resolves its binary via `new URL("../../wasm/….wasm",
import.meta.url)`:

- **Node** — read from disk automatically; nothing to do.
- **Vite / Rolldown / esbuild** — the `new URL` pattern is rewritten to a
  hashed asset URL and fetched; nothing to do.
- **Convex or other sandboxed runtimes** — call the entry's `init()` once
  with your own source before first use. The artifacts are exported as
  package subpaths (`@futuralabs/delta/wasm/*.wasm`) so bundler asset
  imports resolve:

  ```ts
  import { init } from "@futuralabs/delta/gdelta/decode";
  import wasmUrl from "@futuralabs/delta/wasm/gdelta_decode.wasm?url"; // bundler-specific

  await init(new URL(wasmUrl, import.meta.url)); // or bytes / WebAssembly.Module / Response
  ```

## Development

```sh
nix develop        # bun, node, rust + wasm32 target, clang (for libzstd), wasm-opt, biome
bun install
bun run ci         # build (wasm + ts) → typecheck → lint → rust tests → js tests
bun run bench      # size/speed table
```

## License

MIT. Bundles third-party work: the GDelta implementation is ported from the
MIT-licensed [gdelta](https://github.com/ImGajeed76/gdelta) crate (GDelta
algorithm by Haoliang Tan et al.); the zstd artifacts compile
BSD-3-Clause [Zstandard](https://github.com/facebook/zstd). See
[NOTICE](./NOTICE).
