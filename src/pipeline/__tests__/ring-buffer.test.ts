import { describe, expect, it } from "vitest";
import { appendToRingBuffer } from "../ring-buffer";

// Off-by-one regression suite for the ring-buffer pattern used by
// agent.log() to keep activityLog/activityLogErrors/observerLog bounded.
// The historic bug class this guards against: a cap-N buffer briefly
// holding N+1 entries between the push and the slice, or dropping the
// just-appended entry on rollover.

describe("appendToRingBuffer — rollover boundary", () => {
  it("appends into an empty ring", () => {
    expect(appendToRingBuffer<number>([], 1, 5)).toEqual([1]);
  });

  it("appends below cap without dropping", () => {
    expect(appendToRingBuffer([1, 2, 3], 4, 5)).toEqual([1, 2, 3, 4]);
  });

  it("reaching cap keeps every entry", () => {
    // buf len 4, push 5th, cap 5 → exactly full, nothing dropped
    expect(appendToRingBuffer([1, 2, 3, 4], 5, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("exceeding cap by 1 evicts oldest, keeps newest", () => {
    expect(appendToRingBuffer([1, 2, 3, 4, 5], 6, 5)).toEqual([2, 3, 4, 5, 6]);
  });

  it("buffer already over cap is trimmed to cap on next append", () => {
    // Defensive: a corrupted state with too many entries should self-heal
    // on the next log() call rather than persisting the overflow.
    const result = appendToRingBuffer([1, 2, 3, 4, 5, 6, 7], 8, 5);
    expect(result).toHaveLength(5);
    expect(result).toEqual([4, 5, 6, 7, 8]);
  });

  it("cap of 1 keeps only the most recent entry", () => {
    expect(appendToRingBuffer([1, 2, 3], 4, 1)).toEqual([4]);
  });

  it("cap of 0 keeps nothing", () => {
    expect(appendToRingBuffer([1, 2, 3], 4, 0)).toEqual([]);
  });

  it("negative cap keeps nothing", () => {
    expect(appendToRingBuffer([1, 2, 3], 4, -1)).toEqual([]);
  });

  it("NaN cap keeps nothing", () => {
    expect(appendToRingBuffer([1, 2, 3], 4, Number.NaN)).toEqual([]);
  });

  it("Infinity cap keeps nothing", () => {
    expect(appendToRingBuffer([1, 2, 3], 4, Number.POSITIVE_INFINITY)).toEqual(
      []
    );
  });

  it("preserves insertion order across 100+ pushes at cap 40", () => {
    // Models the OBSERVER_LOG_MAX_ENTRIES=40 cap with sustained traffic.
    let buf: number[] = [];
    for (let i = 1; i <= 200; i++) buf = appendToRingBuffer(buf, i, 40);
    expect(buf).toHaveLength(40);
    expect(buf[0]).toBe(161);
    expect(buf[39]).toBe(200);
    // Strictly ascending — order preserved through repeated rollover.
    for (let i = 1; i < buf.length; i++) {
      expect(buf[i]).toBeGreaterThan(buf[i - 1]);
    }
  });
});

describe("appendToRingBuffer — immutability", () => {
  it("does not mutate the input buffer", () => {
    const original = [1, 2, 3];
    const frozen = Object.freeze([...original]) as readonly number[];
    const out = appendToRingBuffer(frozen as number[], 4, 5);
    expect(original).toEqual([1, 2, 3]);
    expect(out).not.toBe(original);
  });
});

describe("appendToRingBuffer — generic over T", () => {
  it("preserves object identity (no deep clone)", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const c = { id: "c" };
    const out = appendToRingBuffer([a, b], c, 5);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
    expect(out[2]).toBe(c);
  });
});
