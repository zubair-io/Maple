/**
 * Daily spend tracker for the describe worker.
 *
 * One Mongo doc per UTC day in the `describe_spend` collection:
 *
 *     { _id: "YYYY-MM-DD", total_usd: number, updated_at: number }
 *
 * The worker reads `getTodaySpend()` before each provider call. When the
 * resolved cap is reached, the worker returns `circuit-pause` for the
 * rest of the UTC day — same shape as a circuit-breaker open. The cap
 * resets at 00:00 UTC because the doc id rolls over.
 *
 * Spec: `docs/indexer-enrichment.md` §6 (per-day cap).
 */

import type { Collection } from "mongodb";
import { getDb } from "../db/client.ts";

const COLL = "describe_spend";

/** Collection accessor — exported so `db/client.ts` can register an index
 * on `_id` (Mongo creates one by default; this helper is here for symmetry
 * with `assetsCollection()` etc.). */
export async function describeSpendCollection(): Promise<
  Collection<DescribeSpendDoc>
> {
  return (await getDb()).collection<DescribeSpendDoc>(COLL);
}

export interface DescribeSpendDoc {
  /** UTC date in `YYYY-MM-DD` form. */
  _id: string;
  total_usd: number;
  updated_at: number;
}

/** Format a `Date` as `YYYY-MM-DD` in UTC (the worker's "today" key). */
export function utcDayKey(d: Date = new Date()): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Read today's total. Returns 0 when no row exists yet (a fresh UTC day). */
export async function getTodaySpend(now: Date = new Date()): Promise<number> {
  const c = await describeSpendCollection();
  const key = utcDayKey(now);
  const doc = await c.findOne({ _id: key });
  return doc?.total_usd ?? 0;
}

/**
 * Atomically add `usd` to today's row (`$inc`, with a `$setOnInsert` for
 * the `_id` so the doc is created on first call). Returns the new total
 * so the caller can decide whether the next call should be allowed.
 *
 * Negative deltas are silently dropped — providers should never report
 * negative cost; treating it as 0 keeps the daily total monotonic.
 */
export async function incrementSpend(
  usd: number,
  now: Date = new Date(),
): Promise<number> {
  if (!(usd > 0)) {
    return getTodaySpend(now);
  }
  const c = await describeSpendCollection();
  const key = utcDayKey(now);
  const updated = Date.now();
  const res = await c.findOneAndUpdate(
    { _id: key },
    { $inc: { total_usd: usd }, $set: { updated_at: updated } },
    { upsert: true, returnDocument: "after" },
  );
  return res?.total_usd ?? usd;
}
