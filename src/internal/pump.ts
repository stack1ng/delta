/**
 * Demand-driven pump shared by the zstd entries: a writable/readable pair
 * over a wasm streaming codec whose output is produced one bounded chunk per
 * downstream pull.
 *
 * Backpressure contract (the reason this is not a TransformStream): a
 * TransformStream must emit everything an input chunk produces inside one
 * `transform()` call, so a small input that decompresses to megabytes gets
 * queued wholesale. Here the codec only advances inside `pull()`, so output
 * beyond the readable's high-water mark is never materialized, and the
 * pending `write()` promise does not resolve until the codec has fully
 * consumed and drained that chunk — upstream stalls while downstream is idle.
 *
 * Teardown contract: `fail()` is the single rally point — it frees the wasm
 * context/buffers, rejects a pending write, errors both stream controllers,
 * and wakes a suspended pull, exactly once. Because fail() errors the
 * controllers directly, pull() never needs to reject — it swallows into
 * fail(), so a pull racing the failure cannot surface as an unhandled
 * rejection. Early teardown (cancel/abort before the wasm module finished
 * loading) is handled by re-checking `failed` inside the init continuation,
 * and aborts with a write in flight are observed via the writable
 * controller's abort signal where the runtime provides one (Bun ≤1.3 does
 * not; there the abort settles when the consumer next pulls or cancels).
 */

import { requireBytes, validateByteCap } from "./bytes.js";
import { type BaseWasmExports, copyIn, copyOut } from "./wasm.js";

/** One bounded output chunk per step keeps queues and latency predictable. */
export const OUT_CAP = 64 * 1024;

const MIN_IN_CAP = 64 * 1024;

/** Hooks binding the pump to one wasm codec direction. */
export interface PumpCodec<E extends BaseWasmExports> {
  exports(): Promise<E>;
  /** Creates the codec context; 0 signals failure. */
  create(exports: E): number;
  createError: string;
  /**
   * One bounded codec step over the current input chunk. Returns the packed
   * `(newInPos << 32) | outProduced` result, negative on codec error.
   */
  step(
    exports: E,
    ctx: number,
    inPtr: number,
    inLen: number,
    inPos: number,
    outPtr: number,
    outCap: number,
  ): bigint;
  stepError: string;
  /** Optional per-code error message for negative step results. */
  stepErrorFor?(code: number): string;
  /**
   * One bounded finalization step after input ends. Runs until `done`;
   * throws to reject the stream (e.g. a truncated frame). Must make
   * progress: `{produced: 0, done: false}` is treated as a codec error.
   */
  end(exports: E, ctx: number, outPtr: number, outCap: number): { produced: number; done: boolean };
  free(exports: E, ctx: number): void;
  /** When set, ending with zero input bytes rejects with this message. */
  emptyInputError?: string;
  /**
   * When true, `end()` validates but never produces output (decompression:
   * a drained codec has nothing left once input ends). The pump then runs
   * it inside `close()` so truncation rejects the writer's `close()`
   * promise and resources are freed even if the readable is never read
   * again.
   */
  finalizesWithoutOutput?: boolean;
}

export interface PumpOptions {
  /** Rejects the stream once total output would exceed this many bytes. */
  maxOutputBytes?: number;
}

export function codecPair<E extends BaseWasmExports>(
  codec: PumpCodec<E>,
  options?: PumpOptions,
): ReadableWritablePair<Uint8Array, Uint8Array> {
  const maxOutputBytes = validateByteCap(options?.maxOutputBytes, "maxOutputBytes");

  let exports: E | undefined;
  let ready: Promise<void> | undefined;
  let ctx = 0;
  let inPtr = 0;
  let inCap = 0;
  let outPtr = 0;

  /** Input chunk already copied into wasm memory, awaiting consumption. */
  let pending: { len: number; pos: number; resolve(): void; reject(e: unknown): void } | undefined;
  let readableController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let writableController: WritableStreamDefaultController | undefined;
  let readableClosed = false;
  let inputClosed = false;
  let finished = false;
  let failed = false;
  let failure: Error;
  let totalIn = 0;
  let totalOut = 0;
  let wake: (() => void) | undefined;

  function signal(): void {
    const resume = wake;
    wake = undefined;
    resume?.();
  }

  function ensureReady(): Promise<void> {
    ready ??= codec
      .exports()
      .then((e) => {
        exports = e;
        if (failed) {
          // Torn down while the module was still loading: create nothing,
          // so there is nothing to leak.
          return;
        }
        ctx = codec.create(e);
        if (ctx === 0) {
          throw new Error(codec.createError);
        }
        outPtr = e.walloc(OUT_CAP);
        if (outPtr === 0) {
          throw new Error("wasm memory exhausted");
        }
      })
      .catch((error) => {
        // Route setup failure through fail(): partial resources (a created
        // ctx without an out buffer) are freed, and the writable errors so
        // a piped upstream source is cancelled instead of stranded.
        throw fail(error);
      });
    return ready;
  }

  /**
   * Best-effort, at-most-once: each handle is cleared before its free is
   * attempted, and a throwing free must not stop the remaining frees or —
   * critically — the fail() path that settles the streams.
   */
  function dispose(): void {
    if (exports === undefined) {
      return;
    }
    const e = exports;
    const liveCtx = ctx;
    ctx = 0;
    const liveIn = inPtr;
    inPtr = 0;
    const liveOut = outPtr;
    outPtr = 0;
    if (liveCtx !== 0) {
      try {
        codec.free(e, liveCtx);
      } catch {}
    }
    if (liveIn !== 0) {
      try {
        e.wfree(liveIn, inCap);
      } catch {}
    }
    if (liveOut !== 0) {
      try {
        e.wfree(liveOut, OUT_CAP);
      } catch {}
    }
  }

  function closeReadable(): void {
    if (!readableClosed) {
      readableClosed = true;
      readableController?.close();
    }
  }

  /** Fails both sides exactly once and returns the error to throw. */
  function fail(reason: unknown): Error {
    if (!failed) {
      failed = true;
      failure = reason instanceof Error ? reason : new Error(String(reason ?? "stream cancelled"));
      dispose();
      pending?.reject(failure);
      pending = undefined;
      // Error both stream objects (no-ops when already closed/errored):
      // erroring the writable is what lets pipeTo observe a readable-side
      // cancel and propagate it back to an idle upstream source.
      readableController?.error(failure);
      writableController?.error(failure);
      signal();
    }
    return failure;
  }

  /** The end() adapter is JS: validate its result at the trust boundary. */
  function invalidEndResult(result: { produced: number; done: boolean }): boolean {
    return (
      !Number.isInteger(result.produced) ||
      result.produced < 0 ||
      result.produced > OUT_CAP ||
      typeof result.done !== "boolean" ||
      (result.produced === 0 && !result.done) ||
      (codec.finalizesWithoutOutput === true && result.produced !== 0)
    );
  }

  function countOutput(produced: number): void {
    totalOut += produced;
    if (totalOut > maxOutputBytes) {
      throw fail(new Error(`output exceeds maxOutputBytes (${maxOutputBytes})`));
    }
  }

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
      return ensureReady();
    },
    async pull(controller) {
      try {
        await drive(controller);
      } catch (error) {
        // fail() is the error channel — it has already errored the
        // controller (or does so now). Resolving here keeps a pull that
        // raced the failure from surfacing as an unhandled rejection on an
        // already-errored stream.
        fail(error);
      }
    },
    cancel(reason) {
      fail(reason);
    },
  });

  async function drive(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    for (;;) {
      if (failed) {
        return;
      }
      const e = exports as E;

      if (pending !== undefined) {
        const posBefore = pending.pos;
        let packed: bigint;
        try {
          packed = codec.step(e, ctx, inPtr, pending.len, pending.pos, outPtr, OUT_CAP);
        } catch (error) {
          // A wasm trap must still tear down cleanly (free what remains
          // freeable, reject the pending write, error both sides).
          throw fail(error);
        }
        if (packed < 0n) {
          throw fail(new Error(codec.stepErrorFor?.(Number(packed)) ?? codec.stepError));
        }
        const newPos = Number(packed >> 32n);
        const produced = Number(packed & 0xffffffffn);
        // Trust boundary: a codec reporting impossible progress (output
        // beyond the buffer, input position moving backwards or past the
        // end) would corrupt downstream state — reject it outright.
        if (produced > OUT_CAP || newPos < posBefore || newPos > pending.len) {
          throw fail(new Error(codec.stepError));
        }
        pending.pos = newPos;
        if (produced === 0 && newPos === posBefore && newPos < pending.len) {
          // A codec that consumes nothing and produces nothing on
          // non-empty input would loop forever; treat it as an error.
          throw fail(new Error(codec.stepError));
        }
        countOutput(produced);
        if (pending.pos >= pending.len && produced < OUT_CAP) {
          // Chunk fully consumed and internal output drained: release the
          // writer so upstream may proceed.
          pending.resolve();
          pending = undefined;
        }
        if (produced > 0) {
          controller.enqueue(copyOut(e.memory, outPtr, produced));
          return;
        }
        continue;
      }

      if (inputClosed) {
        if (codec.emptyInputError !== undefined && totalIn === 0) {
          throw fail(new Error(codec.emptyInputError));
        }
        if (!finished) {
          let result: { produced: number; done: boolean };
          try {
            result = codec.end(e, ctx, outPtr, OUT_CAP);
          } catch (error) {
            throw fail(error);
          }
          if (invalidEndResult(result)) {
            // Finalization must make progress and stay inside the buffer.
            throw fail(new Error(codec.stepError));
          }
          countOutput(result.produced);
          finished = result.done;
          if (result.produced > 0) {
            const chunk = copyOut(e.memory, outPtr, result.produced);
            if (finished) {
              dispose();
            }
            controller.enqueue(chunk);
            if (finished) {
              closeReadable();
            }
            return;
          }
          if (!finished) {
            continue;
          }
        }
        dispose();
        closeReadable();
        return;
      }

      // No input available: wait for the next write, close, or abort.
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  const writable = new WritableStream<Uint8Array>({
    start(controller) {
      writableController = controller;
      // The spec defers sink.abort until in-flight writes settle, but our
      // in-flight write settles only via pull() — observe the abort request
      // directly so it cannot deadlock against an idle consumer. Deferred a
      // microtask so writer.abort()'s own bookkeeping settles first.
      // Feature-detected: Bun (≤1.3) has no controller.signal; there the
      // abort is only observed via sink.abort once in-flight writes settle
      // (i.e. when the consumer next pulls or cancels) — weaker, but every
      // normal operation works.
      controller.signal?.addEventListener(
        "abort",
        () => {
          queueMicrotask(() => fail(controller.signal.reason));
        },
        { once: true },
      );
    },
    async write(chunk) {
      if (failed) {
        throw failure;
      }
      try {
        // A type-violating producer poisons both sides, matching
        // TransformStream semantics for a throwing transform().
        requireBytes(chunk);
      } catch (error) {
        throw fail(error);
      }
      if (chunk.length === 0) {
        return;
      }
      try {
        await ensureReady();
      } catch (error) {
        throw fail(error);
      }
      if (failed) {
        throw failure;
      }
      const e = exports as E;
      totalIn += chunk.length;
      if (chunk.length > inCap) {
        if (inPtr !== 0) {
          e.wfree(inPtr, inCap);
          inPtr = 0;
        }
        const cap = Math.max(chunk.length, MIN_IN_CAP);
        const ptr = e.walloc(cap);
        if (ptr === 0) {
          throw fail(new Error("wasm memory exhausted"));
        }
        inCap = cap;
        inPtr = ptr;
      }
      copyIn(e.memory, inPtr, chunk);
      // Resolved by pull() once the codec has consumed and drained the chunk.
      await new Promise<void>((resolve, reject) => {
        pending = { len: chunk.length, pos: 0, resolve, reject };
        signal();
      });
    },
    close() {
      if (failed) {
        return Promise.reject(failure);
      }
      inputClosed = true;
      if (codec.emptyInputError !== undefined && totalIn === 0) {
        return Promise.reject(fail(new Error(codec.emptyInputError)));
      }
      // Validation-only finalization can run right here: truncation then
      // rejects close() (like a TransformStream flush error), and resources
      // are freed even if the readable is never read again. `pending` is
      // always undefined here — close waits for queued writes.
      if (codec.finalizesWithoutOutput === true && exports !== undefined && ctx !== 0) {
        try {
          const result = codec.end(exports, ctx, outPtr, OUT_CAP);
          if (invalidEndResult(result)) {
            throw new Error(codec.stepError);
          }
          finished = result.done;
        } catch (error) {
          return Promise.reject(fail(error));
        }
        dispose();
        closeReadable();
      }
      signal();
      return Promise.resolve();
    },
    abort(reason) {
      fail(reason);
    },
  });

  return { readable, writable };
}
