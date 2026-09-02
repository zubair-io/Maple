/**
 * Deterministic frame-timestamp selection for the `video-describe` stage
 * (#2158 design doc, "Bounded frame sampling").
 *
 * Pure — no ffmpeg, no I/O. Takes the ordered keyframe candidates
 * `probe.ts` extracted (each with a small difference thumbnail) and
 * returns an ordered list of TIMESTAMPS to actually decode at full
 * resolution. The candidate timestamps are not the only ones that can be
 * returned: the "uniform duration anchor" fallback below synthesizes new
 * timestamps that were never I-frames — `frame-extract.ts` seeks and
 * decodes whatever timestamp it is handed, keyframe or not, so this is
 * safe.
 *
 * Algorithm (design doc, "Bounded frame sampling"):
 *
 *   1. Zero candidates → no frames (the stage treats this as a terminal
 *      "no decodable frame" skip).
 *   2. One candidate → that single frame. Valid for static or very short
 *      clips — one frame is honest, not a degraded result.
 *   3. Otherwise: the first candidate is always retained, as the anchor the
 *      rest are compared against. Walk every remaining candidate — INCLUDING
 *      the last — in order; each survives when its normalized mean pixel
 *      difference against the LAST RETAINED candidate's thumbnail is at or
 *      above `DIFF_THRESHOLD`. A clip whose frames never diverge from the
 *      first therefore yields a single survivor, not a forced pair — that
 *      is exactly the "fewer than two survivors" case step 5 exists for.
 *   4. More than `TARGET_FRAME_COUNT` survivors → uniformly downselect to
 *      `TARGET_FRAME_COUNT`, keeping the survivor list's own first and last
 *      entries fixed.
 *   5. Fewer than two survivors on a clip longer than `MIN_NONTRIVIAL_SEC`
 *      → fill in evenly-spaced timestamps across the duration (the clip is
 *      visually static across every one of its keyframes, but the model
 *      still benefits from seeing several points across the timeline) and
 *      dedupe anything within `ANCHOR_DEDUPE_SEC` of the existing pick.
 */

import { DIFF_THRESHOLD, DIFF_THUMB_BYTES, TARGET_FRAME_COUNT } from './constants.ts';
import type { FrameCandidate } from './probe.ts';

/** Below this duration, a thin (even single-frame) result is expected and
 * correct — nothing to "fill in" on a clip this short. */
const MIN_NONTRIVIAL_SEC = 2;

/** Two picked timestamps closer than this are treated as the same moment —
 * keeps the anchor-fill step from adding a near-duplicate of a survivor. */
const ANCHOR_DEDUPE_SEC = 0.5;

/** Normalized mean per-channel pixel difference between two equal-length
 * RGB24 buffers, on a `[0, 1]` scale. `1` requires both buffers to be
 * `DIFF_THUMB_BYTES` long — a mismatch is a caller bug, not a data
 * condition, so it throws rather than silently comparing garbage. */
export function meanPixelDifference(a: Buffer, b: Buffer): number {
  if (a.length !== DIFF_THUMB_BYTES || b.length !== DIFF_THUMB_BYTES) {
    throw new Error(`meanPixelDifference: expected ${DIFF_THUMB_BYTES}-byte buffers`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  }
  return sum / (a.length * 255);
}

/** Pick `k` indices from `[0, n)`, always including `0` and `n - 1`,
 * spread as evenly as possible in between. Returns fewer than `k` only
 * when rounding collapses two targets onto the same index (harmless — the
 * design doc caps at `TARGET_FRAME_COUNT`, it does not require exactly
 * that many). */
function uniformIndices(n: number, k: number): number[] {
  if (k >= n) return Array.from({ length: n }, (_, i) => i);
  const picked = new Set<number>();
  for (let i = 0; i < k; i++) {
    picked.add(Math.round((i * (n - 1)) / (k - 1)));
  }
  return [...picked].sort((x, y) => x - y);
}

/** The first candidate seeds `retained`; every later one — including the
 * final candidate — is judged purely on its difference from the last
 * RETAINED thumbnail. Nothing is force-kept beyond the first: a clip whose
 * frames never meaningfully change ends with exactly one survivor, which is
 * what makes the "fewer than two survivors" anchor-fill step (below)
 * reachable at all. */
function dedupeSurvivors(candidates: readonly FrameCandidate[]): FrameCandidate[] {
  if (candidates.length === 0) return [];
  const retained: FrameCandidate[] = [candidates[0]!];
  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const diff = meanPixelDifference(candidate.diffThumb, retained[retained.length - 1]!.diffThumb);
    if (diff >= DIFF_THRESHOLD) retained.push(candidate);
  }
  return retained;
}

function downselect(retained: readonly FrameCandidate[]): FrameCandidate[] {
  if (retained.length <= TARGET_FRAME_COUNT) return [...retained];
  return uniformIndices(retained.length, TARGET_FRAME_COUNT).map((i) => retained[i]!);
}

/** Evenly-spaced timestamps across `[0, durationSec)`, `count` of them,
 * excluding a leading/trailing anchor at exactly 0 or the duration (those
 * are exactly the endpoints already retained). */
function durationAnchors(durationSec: number, count: number): number[] {
  const anchors: number[] = [];
  for (let i = 1; i <= count; i++) {
    anchors.push((durationSec * i) / (count + 1));
  }
  return anchors;
}

function fillFromDurationAnchors(timestamps: readonly number[], durationSec: number): number[] {
  if (timestamps.length >= 2 || durationSec <= MIN_NONTRIVIAL_SEC) return [...timestamps];
  const merged = [...timestamps];
  // Enough anchors to comfortably clear the 2-survivor floor even after
  // dedupe collapses one or two against the existing pick(s).
  for (const anchor of durationAnchors(durationSec, TARGET_FRAME_COUNT)) {
    if (merged.some((t) => Math.abs(t - anchor) < ANCHOR_DEDUPE_SEC)) continue;
    merged.push(anchor);
  }
  return merged.sort((a, b) => a - b);
}

/**
 * Select the ordered timestamps (seconds) to send to the vision model, from
 * the probe's ordered candidates and the clip's total duration.
 */
export function selectFrameTimestamps(
  candidates: readonly FrameCandidate[],
  durationSec: number,
): number[] {
  if (candidates.length === 0) return [];
  if (candidates.length === 1) return [candidates[0]!.timestampSec];

  const survivors = downselect(dedupeSurvivors(candidates));
  const timestamps = survivors.map((c) => c.timestampSec);
  return fillFromDurationAnchors(timestamps, durationSec);
}
