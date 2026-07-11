/**
 * Lazy per-entry WASM loading.
 *
 * Each public entrypoint owns exactly one wasm binary and instantiates it on
 * first use, so importing an entry never loads another entry's wasm. In Node
 * the binary is read from disk next to the package; elsewhere it is fetched
 * (bundlers rewrite the `new URL(..., import.meta.url)` reference to an
 * asset URL). Runtimes without either path (e.g. Convex) call the entry's
 * exported `init(source)` with precompiled bytes or a module.
 *
 * The default URL stays lazy because some isolates throw when `import.meta`
 * is evaluated. Explicit `init(source)` touches no URL, fetch, or filesystem.
 */

/** Acceptable inputs for an entry's `init()`. */
export type WasmSource = WebAssembly.Module | BufferSource | Response | URL;

/** Common exports every artifact provides. */
export interface BaseWasmExports {
  readonly memory: WebAssembly.Memory;
  walloc(len: number): number;
  wfree(ptr: number, len: number): void;
}

/**
 * Compiles a Response, tolerating servers that omit the
 * `application/wasm` MIME type (where `compileStreaming` refuses).
 */
async function compileResponse(response: Response): Promise<WebAssembly.Module> {
  if (typeof WebAssembly.compileStreaming === "function") {
    try {
      return await WebAssembly.compileStreaming(response.clone());
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error;
      }
      // Wrong/missing MIME type: fall through to the buffered path.
    }
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

async function compileFrom(
  source: WasmSource | undefined,
  defaultUrl: () => URL,
): Promise<WebAssembly.Module> {
  if (source instanceof WebAssembly.Module) {
    return source;
  }
  // Both globals guarded: minimal runtimes lack Response (no Fetch) or even
  // URL, and explicit module/bytes init is exactly the escape hatch such
  // runtimes use — that path must reference neither.
  let target: URL;
  if (typeof URL !== "undefined" && source instanceof URL) {
    target = source;
  } else if (source !== undefined) {
    if (typeof Response !== "undefined" && source instanceof Response) {
      return compileResponse(source);
    }
    return WebAssembly.compile(source as BufferSource);
  } else {
    target = defaultUrl();
  }
  const isNode =
    typeof process !== "undefined" &&
    process.versions?.node !== undefined &&
    target.protocol === "file:";
  if (isNode) {
    const specifier = "fs/promises";
    const { readFile } = process.getBuiltinModule?.(specifier) ?? (await import(specifier));
    const bytes = await readFile(target);
    return WebAssembly.compile(bytes);
  }
  return compileResponse(await fetch(target));
}

/** A lazily instantiated wasm module tied to one entrypoint. */
export interface LazyWasm<E extends BaseWasmExports> {
  /**
   * Optionally pre-initializes the module, overriding the default loading
   * strategy. Must be called before first use to take effect.
   */
  init(source?: WasmSource): Promise<void>;
  /** Returns the instantiated exports, loading the module on first call. */
  exports(): Promise<E>;
}

/** Callable exports every artifact must provide, plus the entry's own ABI. */
const COMMON_CALLABLES = ["walloc", "wfree"] as const;

export function lazyWasm<E extends BaseWasmExports>(
  defaultUrl: () => URL,
  requiredExports: readonly string[],
): LazyWasm<E> {
  let instantiated: Promise<E> | undefined;

  function instantiate(source?: WasmSource): Promise<E> {
    const attempt = compileFrom(source, defaultUrl)
      .then((module) => WebAssembly.instantiate(module, {}))
      .then((instance) => {
        // Reject a wrong or malformed artifact BEFORE caching it, so a
        // corrected init() can still succeed afterwards. Names alone are
        // not enough: a structurally valid module can export `memory` as a
        // global or a required callable as a non-function.
        const exportsObject = instance.exports as Record<string, unknown>;
        const problems: string[] = [];
        if (!(exportsObject.memory instanceof WebAssembly.Memory)) {
          problems.push(
            "memory" in exportsObject ? "memory is not a WebAssembly.Memory" : "memory is missing",
          );
        }
        for (const name of [...COMMON_CALLABLES, ...requiredExports]) {
          if (typeof exportsObject[name] !== "function") {
            problems.push(
              name in exportsObject ? `${name} is not a function` : `${name} is missing`,
            );
          }
        }
        if (problems.length > 0) {
          throw new Error(
            `wasm module is missing required exports or exports the wrong kinds (wrong artifact?): ${problems.join("; ")}`,
          );
        }
        return instance.exports as unknown as E;
      });
    // A failed load must not poison the entry forever: clear the cache so a
    // later init()/first-use can retry (e.g. with a corrected source).
    attempt.catch(() => {
      if (instantiated === attempt) {
        instantiated = undefined;
      }
    });
    return attempt;
  }

  return {
    async init(source?: WasmSource): Promise<void> {
      instantiated ??= instantiate(source);
      await instantiated;
    },
    exports(): Promise<E> {
      instantiated ??= instantiate();
      return instantiated;
    },
  };
}

/** Copies `bytes` into wasm memory at `ptr`. */
export function copyIn(memory: WebAssembly.Memory, ptr: number, bytes: Uint8Array): void {
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
}

/** Copies `len` bytes of wasm memory at `ptr` out into a fresh Uint8Array. */
export function copyOut(memory: WebAssembly.Memory, ptr: number, len: number): Uint8Array {
  return new Uint8Array(memory.buffer.slice(ptr, ptr + len));
}
