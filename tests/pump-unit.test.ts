/**
 * Pump lifecycle unit tests against fake codecs — no wasm involved, so
 * failure modes that are hard to force through libzstd (context-creation
 * failure, allocation failure, a finalizer that makes no progress) are
 * exercised directly through the documented PumpCodec ABI.
 */

import { describe, expect, it } from "vitest";
import { codecPair, OUT_CAP, type PumpCodec } from "../src/internal/pump.js";
import type { BaseWasmExports } from "../src/internal/wasm.js";

interface FakeState {
  freed: number[];
  allocFailAfter: number;
}

function fakeExports(state: FakeState): BaseWasmExports {
  let next = 8;
  let allocs = 0;
  return {
    memory: new WebAssembly.Memory({ initial: 4 }),
    walloc(len: number): number {
      allocs += 1;
      if (allocs > state.allocFailAfter) {
        return 0;
      }
      const ptr = next;
      next += len;
      return ptr;
    },
    wfree(ptr: number): void {
      state.freed.push(ptr);
    },
  };
}

function fakeCodec(
  state: FakeState,
  overrides: Partial<PumpCodec<BaseWasmExports>>,
): PumpCodec<BaseWasmExports> {
  return {
    exports: () => Promise.resolve(fakeExports(state)),
    create: () => 1,
    createError: "fake: create failed",
    step: (_e, _ctx, _inPtr, inLen) => (BigInt(inLen) << 32n) | 0n,
    stepError: "fake: step failed",
    end: () => ({ produced: 0, done: true }),
    free: (_e, ctx) => {
      state.freed.push(-ctx);
    },
    ...overrides,
  };
}

// Echo codec: consumes everything offered, produces that many bytes.
const echo = (inLen: number, inPos: number) => (BigInt(inLen) << 32n) | BigInt(inLen - inPos);

function abiViolation(step: PumpCodec<BaseWasmExports>["step"]): ReturnType<typeof codecPair> {
  const state: FakeState = { freed: [], allocFailAfter: Number.POSITIVE_INFINITY };
  return codecPair(fakeCodec(state, { step }));
}

async function expectStepRejection(pair: ReturnType<typeof codecPair>): Promise<void> {
  const reader = pair.readable.getReader();
  const write = pair.writable.getWriter().write(new Uint8Array(16));
  write.catch(() => {});
  const drain = (async () => {
    for (;;) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
    }
  })();
  await expect(drain).rejects.toThrow(/step failed/);
  await expect(write).rejects.toThrow(/step failed/);
}

function stalledSource(): { stream: ReadableStream<Uint8Array>; cancelled(): boolean } {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull() {
      await new Promise(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

describe("pump initialization failure", () => {
  it("context-creation failure errors both sides and cancels a piped source", async () => {
    const state: FakeState = { freed: [], allocFailAfter: Number.POSITIVE_INFINITY };
    const pair = codecPair(fakeCodec(state, { create: () => 0 }));
    const source = stalledSource();

    const reader = source.stream.pipeThrough(pair).getReader();
    await expect(reader.read()).rejects.toThrow(/create failed/);
    // pipeTo observes the errored writable and propagates backwards.
    await new Promise((r) => setTimeout(r, 20));
    expect(source.cancelled()).toBe(true);
  });

  it("output-allocation failure frees the created context", async () => {
    const state: FakeState = { freed: [], allocFailAfter: 0 };
    const pair = codecPair(fakeCodec(state, { create: () => 42 }));

    const reader = pair.readable.getReader();
    await expect(reader.read()).rejects.toThrow(/memory exhausted/);
    expect(state.freed).toContain(-42);
  });

  it("write() rejects when setup already failed", async () => {
    const state: FakeState = { freed: [], allocFailAfter: Number.POSITIVE_INFINITY };
    const pair = codecPair(fakeCodec(state, { create: () => 0 }));
    const drain = pair.readable
      .getReader()
      .read()
      .catch(() => {});
    await expect(pair.writable.getWriter().write(new Uint8Array(4))).rejects.toThrow(
      /create failed/,
    );
    await drain;
  });
});

describe("pump finalization invariants", () => {
  it("a no-progress finalizer rejects instead of spinning", async () => {
    const state: FakeState = { freed: [], allocFailAfter: Number.POSITIVE_INFINITY };
    const pair = codecPair(
      fakeCodec(state, {
        end: () => ({ produced: 0, done: false }),
      }),
    );

    const writer = pair.writable.getWriter();
    const reading = pair.readable.getReader().read();
    await writer.write(new Uint8Array(8));
    const closed = writer.close();
    closed.catch(() => {});
    await expect(reading).rejects.toThrow(/step failed/);
  });

  it("a progressing finalizer drains to completion", async () => {
    const state: FakeState = { freed: [], allocFailAfter: Number.POSITIVE_INFINITY };
    let flushes = 2;
    const pair = codecPair(
      fakeCodec(state, {
        end: () => {
          flushes -= 1;
          return { produced: 16, done: flushes === 0 };
        },
      }),
    );

    const writer = pair.writable.getWriter();
    const collected: number[] = [];
    const reading = (async () => {
      for await (const chunk of pair.readable) {
        collected.push(chunk.length);
      }
    })();
    await writer.write(new Uint8Array(8));
    await writer.close();
    await reading;
    expect(collected).toEqual([16, 16]);
    // Context freed exactly once.
    expect(state.freed.filter((f) => f === -1)).toEqual([-1]);
  });
});

describe("pump output cap", () => {
  it("caps codec output exactly at maxOutputBytes", async () => {
    const state: FakeState = { freed: [], allocFailAfter: Number.POSITIVE_INFINITY };
    const make = (cap: number) =>
      codecPair(fakeCodec(state, { step: (_e, _c, _p, inLen, inPos) => echo(inLen, inPos) }), {
        maxOutputBytes: cap,
      });

    const ok = make(OUT_CAP);
    const okWriter = ok.writable.getWriter();
    const okRead = ok.readable.getReader().read();
    await okWriter.write(new Uint8Array(OUT_CAP));
    expect((await okRead).value?.length).toBe(OUT_CAP);

    const tight = make(OUT_CAP - 1);
    const tightWriter = tight.writable.getWriter();
    const tightRead = tight.readable.getReader().read();
    tightWriter.write(new Uint8Array(OUT_CAP)).catch(() => {});
    await expect(tightRead).rejects.toThrow(/maxOutputBytes/);
  });
});

describe("pump ABI trust boundary", () => {
  it("rejects output counts beyond OUT_CAP", async () => {
    await expectStepRejection(
      abiViolation((_e, _c, _p, inLen) => (BigInt(inLen) << 32n) | BigInt(OUT_CAP + 1)),
    );
  });

  it("rejects input positions moving backwards", async () => {
    let calls = 0;
    await expectStepRejection(
      abiViolation((_e, _c, _p, inLen) => {
        calls += 1;
        // First call consumes half; second call reports an earlier position.
        return calls === 1 ? (BigInt(inLen >> 1) << 32n) | BigInt(OUT_CAP) : (0n << 32n) | 1n;
      }),
    );
  });

  it("rejects input positions past the chunk end", async () => {
    await expectStepRejection(abiViolation((_e, _c, _p, inLen) => (BigInt(inLen + 1) << 32n) | 0n));
  });

  it("rejects finalization output beyond OUT_CAP", async () => {
    const state: FakeState = { freed: [], allocFailAfter: Number.POSITIVE_INFINITY };
    const pair = codecPair(
      fakeCodec(state, { end: () => ({ produced: OUT_CAP + 1, done: true }) }),
    );
    const writer = pair.writable.getWriter();
    const reading = pair.readable.getReader().read();
    await writer.write(new Uint8Array(8));
    writer.close().catch(() => {});
    await expect(reading).rejects.toThrow(/step failed/);
  });
});
