# Implementation prompt — `@…/delta` (standalone npm package)

You are implementing a **standalone, low-level, tree-shakable npm library** for binary delta + compression, published for Node and bundlers (including Convex’s default WASM-capable runtime). Multiple agents may implement this from the same prompt; the goal is a clean, comparable result.

Work in this repository root: `/Users/thomaseaton/Documents/GitHub/delta` (already a git repo). Do not depend on the sibling `pyro` monorepo at runtime; you may **mirror its tooling conventions** (described below).

---

## 1. Product intent

Build a library that exposes:

1. **GDelta** — structural binary delta (old ↔ new → patch / patch + old → new).
2. **Zstd** — general-purpose compression (bytes in → bytes out), usable alone.
3. **Optional framed pipeline** — default “product” path: `gdelta.encode` then `zstd.compress` on the delta (and the reverse on decode), with an explicit wire frame so algorithms stay swappable.

This is a **low-level** library:

- **No** string helpers, JSON helpers, path helpers, or “encode this object” APIs.
- Prefer **Web Streams** (`ReadableStream` / `WritableStream` / `TransformStream`) and/or the **lowest-level native representation** each algorithm can emit without forced full-buffer copies in *our* code.
- The **consumer** owns buffering strategy. We must not add unnecessary intermediate `Uint8Array` materialization when the underlying algorithm can stream.

**Primary optimization target:** smallest wire/patch size for similar opaque payloads (often JSON snapshots or sliding windows), with near-linear encode cost. Encode latency at ≤50KB is expected to be sub-millisecond; do not sacrifice size for micro-optimizations.

---

## 2. Algorithm facts (do not reinvent incorrectly)

### GDelta

- Structural delta: COPY from `old` + INSERT/LITERAL for unmatched bytes.
- Encode needs **random access to full `old`** and a full (or fully readable) **`new`** to produce a correct delta. You cannot “stream an unbounded `new` through gdelta” without changing the problem.
- Decode needs **full `old`** (COPY offsets) but can consume the **delta** sequentially and emit **`new`** incrementally.
- Encode **output** (the raw delta) can be produced incrementally as ops are emitted — support streaming the delta *out* wherever the Rust/C API allows.
- Complexity: ~**O(n)** time, low memory relative to suffix-array diffs. Designed for small–medium similar chunks (paper/impl target ~4–64KB; still usable larger).

Upstream reference implementation: [ImGajeed76/gdelta](https://github.com/ImGajeed76/gdelta) (Rust, MIT) — GDelta algorithm by Haoliang Tan et al.

### Zstd

- Entropy/LZ compressor. Streaming compress/decompress is first-class in libzstd.
- In the **pipeline**, zstd compresses the **gdelta patch bytes**, not a second old↔new diff.
- Optionally expose dictionary / “patch-from” style APIs later as a *separate* backend; do **not** conflate that with the gdelta+zstd pipeline in v1 unless framed as a distinct algo id.

Upstream: [facebook/zstd](https://github.com/facebook/zstd) (BSD / GPLv2 dual).

### Pipeline (facade only)

```
encode:  (old, new) → gdelta delta bytes → zstd → framed wire
decode:  framed wire → zstd → gdelta delta bytes → gdelta.decode(old) → new
```

GDelta and Zstd packages/modules must **not** import each other. Only the facade composes them.

---

## 3. Package architecture & tree-shaking

### 3.1 Hard requirement: separate encode / decode / algo / WASM

Design for **maximum tree-shaking**, including **separate WASM binaries** per import path so unused algos and unused directions are not pulled into the bundle.

Suggested public entrypoints (exact names may vary, but the *seams* must exist):

| Entrypoint | Contains | WASM |
|---|---|---|
| `@scope/delta/gdelta/encode` | GDelta encode only | `gdelta_encode.wasm` (or equivalent) |
| `@scope/delta/gdelta/decode` | GDelta decode only | `gdelta_decode.wasm` |
| `@scope/delta/zstd/compress` | Zstd compress only | `zstd_compress.wasm` |
| `@scope/delta/zstd/decompress` | Zstd decompress only | `zstd_decompress.wasm` |
| `@scope/delta/pipeline` (or `/framed`) | Framing + compose encode→zstd / zstd→decode | imports the above; no extra fused WASM required for v1 |
| `@scope/delta` | Re-exports documented surface (may be convenience; must not force loading all WASM) | — |

**Rules:**

- Importing decode must not load encode WASM (and vice versa).
- Importing zstd must not load gdelta WASM (and vice versa).
- Prefer **side-effect-free** ESM; initialize WASM lazily on first use (`WebAssembly.compile` / instantiate), with an optional explicit `init()` if needed for Convex/bundlers.
- Document how Convex / Rolldown / Vite should import `.wasm` (or embedded base64 if you choose embed — prefer **separate `.wasm` assets** when tree-shaking matters; embed only if you can still split per entry).

### 3.2 Internal crates / build

Recommended layout (adjust if justified, keep seams):

```
delta/
  packages/          # or single package with conditional exports
    gdelta-encode/
    gdelta-decode/
    zstd-compress/
    zstd-decompress/
    pipeline/
  crates/            # Rust
    gdelta-encode-wasm/
    gdelta-decode-wasm/
    … or one crate with feature flags that emit *separate* wasm artifacts
  native/zstd/       # or rust zstd bindings compiled to separate wasm
  scripts/build-wasm.*
```

Compile with size-oriented flags where it does not wreck encode quality (`-Oz` / `wasm-opt`, LTO, stripped exports). Export only the C/Rust symbols each entry needs.

**License:** prefer MIT/Apache-2.0 for first-party code; vendor gdelta (MIT) and zstd (BSD) with clear `NOTICE` / attribution. **Do not** depend on AGPL packages (e.g. xpatch-rs).

---

## 4. API surface (low-level, stream-first)

### 4.1 Principles

1. **Bytes and streams only** — `Uint8Array`, `Buffer` (Node), `ReadableStream<Uint8Array>`, `WritableStream<Uint8Array>`, `TransformStream`.
2. Where an algorithm **cannot** stream an input (gdelta needs full `old`; encode needs full `new`), the API should make that explicit: e.g. `old: Uint8Array | ArrayBuffer` (or a random-access `SourceReader` with `size` + `read(offset, into)`), not a fake “stream old” that secretly buffers.
3. Where an algorithm **can** stream (zstd; gdelta delta output; gdelta decode output), expose streams and avoid collecting into one array inside the library.
4. Provide **both**:
   - streaming APIs (primary), and
   - thin one-shot helpers that are clearly documented as convenience wrappers over streams/buffers (optional; if present, implement *on top of* the streaming path, not the other way around).

### 4.2 Suggested shapes (illustrative — refine for ergonomics)

**Zstd compress**

```ts
// TransformStream: uncompressed chunks in → compressed chunks out
export function compressTransform(options?: { level?: number }): TransformStream<Uint8Array, Uint8Array>;

// Or sink/source pair following WHATWG / Node stream idioms
export function compress(): { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> };
```

**Zstd decompress** — same pattern, reverse.

**GDelta encode**

```ts
export type RandomAccessSource = {
  readonly size: number;
  read(offset: number, into: Uint8Array): number | Promise<number>;
};

// old: random-access or full buffer; new: full buffer OR readable that is fully consumed before/during encode
// out: ReadableStream of raw gdelta patch bytes (do not zstd here)
export function encodeDelta(
  old: Uint8Array | RandomAccessSource,
  newBytes: Uint8Array | ReadableStream<Uint8Array>, // if stream: may buffer new internally — document clearly
): ReadableStream<Uint8Array>;
```

If true streaming of `new` through gdelta is impossible without buffering, **document that** and either:

- require `Uint8Array` for `new`, or  
- accept a stream but state that the implementation buffers `new` before encode (honest API).

Prefer honesty over a fake zero-copy story.

**GDelta decode**

```ts
// old: random-access or full buffer; delta: ReadableStream; out: ReadableStream of reconstructed new
export function decodeDelta(
  old: Uint8Array | RandomAccessSource,
  delta: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array>;
```

**Pipeline / framed**

```ts
export function encodeFramed(old, newBytes, options?: { zstdLevel?: number }): ReadableStream<Uint8Array>;
export function decodeFramed(old, framed: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
```

Framing must include at least: magic, version, algorithm id / flags (`gdelta-raw` | `gdelta+zstd` | maybe `full+zstd` escape), then body. Keep the frame spec versioned and tested.

### 4.3 Node idioms

- Prefer **Web Streams** (available in Node 18+/24) as the portable core.
- Optionally add Node `stream.Readable` / `Writable` adapters in a separate entry (`/node`) so the core stays isomorphic — do not force Node streams into the default isomorphic path.
- Match Node/Web conventions for backpressure; do not ignore `WritableStreamDefaultWriter` backpressure.

### 4.4 Explicit non-goals (v1)

- No string/JSON/UTF-8 helpers.
- No HTTP client, no filesystem path API.
- No AGPL dependencies.
- No requirement to match VCDIFF/xdelta wire format.
- No qbsdiff/bsdiff in v1 (superlinear; optional later behind another algo id).

---

## 5. Tooling (Nix-flavored, pyro-aligned)

Mirror the **toolchain split** used by pyro ([decision 0004](https://github.com/…)/docs): **Nix pins tools; Bun’s lockfile pins JS packages.** Do not Nix-manage `node_modules`.

### 5.1 Nix flake

Add `flake.nix` + `nix/devshell.nix` similar in spirit to pyro:

- Systems: `aarch64-darwin`, `aarch64-linux`, `x86_64-linux` (skip dead `x86_64-darwin` unless needed).
- Devshell packages should include at least:
  - `bun` (package manager)
  - `nodejs_24` (runtime / tests)
  - `biome` (formatter only)
  - `rustc`, `cargo`, `wasm-pack` and/or `rustup` targets as needed for `wasm32-unknown-unknown`
  - `binaryen` (`wasm-opt`) if available in nixpkgs
  - `pkg-config` as needed
- Shell hook: short identity line when interactive.

`nix develop` on a clean machine → `bun install` → typecheck/lint/test green is the gate.

### 5.2 JS tooling (lockfile-pinned)

- **Bun** — package manager / scripts.
- **TypeScript** — strict; follow pyro-ish `tsconfig` defaults (`strict`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `moduleResolution: bundler`, etc.).
- **Biome** — **formatter + organize imports only** (`linter.enabled: false`), same philosophy as pyro.
- **Oxlint** — **linter** (`.oxlintrc.json`); do not use Biome as linter; do not add ESLint.
- **Vitest** — unit/integration tests in Node environment.
- Optional: Rolldown/tsdown for publishing ESM — only if needed; keep published surface ESM-first.

Root scripts (suggested):

```json
{
  "scripts": {
    "build": "… wasm + tsc/tsdown …",
    "typecheck": "tsc --noEmit",
    "lint": "biome check . && oxlint",
    "lint:fix": "biome check --write . && oxlint --fix",
    "test": "vitest run",
    "ci": "bun run build && bun run typecheck && bun run lint && bun run test"
  }
}
```

### 5.3 Package manager / publish

- `package.json` `"type": "module"`.
- Conditional `exports` map for every tree-shakable entry.
- Ship `.wasm` files next to JS (or document embed strategy).
- Exact-pin critical native/wasm build tooling versions in the lockfile / CI.

### 5.4 CI (GitHub Actions) — build & test only

Include a **GitHub Actions** workflow that runs on PRs and pushes to the default branch:

- Install toolchain (or use a Nix-based job that matches the flake/devshell).
- `bun install`
- Build WASM + JS (`bun run build`)
- `bun run typecheck && bun run lint && bun run test` (or `bun run ci`)

**Do not** set up npm publishing, release-please, tags→publish, or OIDC publish credentials in this phase. Publishing will be added later after comparing implementations and choosing a winner.

---

## 6. Correctness & performance requirements

### Tests (required)

1. **Round-trip:** random + structured fixtures (JSON-like text, binary, sliding-window “drop head / append tail”).
2. **Pipeline:** framed gdelta+zstd round-trip equals input `new`.
3. **Tree-shake / entry isolation (CI smoke):** importing decode entry does not instantiate encode WASM (assert via separate builds, import graphs, or size budgets — pick something enforceable).
4. **Streaming:** zstd compress/decompress through `TransformStream` with chunked input matches one-shot.
5. **GDelta decode streaming:** feed delta in small chunks; output matches.
6. **Fallback policy (if implemented):** if compressed delta ≥ compressed full `new`, framed mode may send full snapshot — document and test.

### Benchmarks (required, checked in as a script)

On representative sizes (e.g. 4KB, 50KB, 256KB, 1MB) report:

- patch size (raw gdelta, gdelta+zstd, zstd-only full, optional zstd dict if implemented)
- encode/decode time  

Do not gate CI on absolute timings; gate on round-trip and size regressions if you set budgets.

### Performance rules

- No extra full-buffer copies in the hot path beyond what the algorithm requires.
- Prefer writing into caller-provided buffers / streaming sinks when wrapping WASM memory.
- Document WASM memory growth behavior.

---

## 7. Documentation to produce

1. **README** — install, entrypoints table, minimal encode/decode examples (streams), framing overview, license/attribution.
2. **FRAME.md** (or section) — byte-level frame layout.
3. **ARCHITECTURE.md** — seams, why encode/decode WASM are split, what can/can’t stream.
4. Keep comments in code proportional; do not narrate obvious code.

---

## 8. Implementation order (suggested)

1. Scaffold flake, biome, oxlint, tsconfig, vitest, package exports.
2. Build **zstd compress** + **zstd decompress** WASM entries + stream APIs + tests.
3. Build **gdelta encode** + **gdelta decode** WASM entries + APIs + tests (vendor/port MIT gdelta).
4. Add **framed pipeline** composing them without merging WASM.
5. Benchmarks + README + CI script.
6. Polish tree-shaking verification and publish config.

---

## 9. Acceptance checklist

- [ ] `nix develop` provides bun, node, biome, rust/wasm toolchain
- [ ] `bun run ci` passes
- [ ] GitHub Actions workflow runs build + typecheck + lint + test on PR/push (no publish)
- [ ] Separate export paths for gdelta encode, gdelta decode, zstd compress, zstd decompress, pipeline
- [ ] Separate WASM artifacts per path (no single mega-wasm required for “decode only”)
- [ ] Stream-first APIs; no string/JSON helpers
- [ ] GDelta and Zstd do not import each other; pipeline is the only composer
- [ ] Framed gdelta→zstd round-trips
- [ ] Licenses/attribution correct (no AGPL)
- [ ] README documents streaming limits honestly (full `old`; encode needs full `new`)

---

## 10. Out of scope / defer

- Browser UI demos
- VCDIFF/xdelta compatibility
- qbsdiff
- Binding to pyro’s spool/LiveActivities (consumers will do that)

---

## 11. Tone for implementers

Prefer a small, boring, correct API over cleverness. Match Node/Web stream idioms. Make tree-shaking and encode/decode splits *structural*, not documentary. When unsure whether something can stream, measure against the algorithm’s real requirements and document the constraint instead of hiding a buffer.
