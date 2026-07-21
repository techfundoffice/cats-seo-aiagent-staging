/**
 * Tiny pure helper used by `agent.log()` to append an entry to a capped
 * ring buffer (FIFO eviction). Returns a new array; never mutates `buf`.
 * Extracted from the inline pattern in `src/server.ts` so the rollover
 * behavior — especially the off-by-one boundary at `buf.length === cap`
 * and `cap + 1` — can be tested in isolation. Non-positive or non-finite
 * caps are treated as "keep nothing" so misconfigured callers do not retain
 * the full buffer via `slice(-0)` / `slice(-NaN)`.
 */
export function appendToRingBuffer<T>(buf: T[], entry: T, cap: number): T[] {
  if (!Number.isFinite(cap) || cap <= 0) return [];
  return [...buf, entry].slice(-Math.trunc(cap));
}
