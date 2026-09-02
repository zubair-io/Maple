import { describe, expect, it } from 'bun:test';
import { DIFF_THUMB_BYTES, TARGET_FRAME_COUNT } from './constants.ts';
import { meanPixelDifference, selectFrameTimestamps } from './frame-select.ts';
import type { FrameCandidate } from './probe.ts';

/** A uniform-color thumbnail — every byte set to `value`. Two thumbnails
 * built from far-apart values differ by roughly `|a - b| / 255`. */
function thumb(value: number): Buffer {
  return Buffer.alloc(DIFF_THUMB_BYTES, value);
}

function candidate(timestampSec: number, value: number): FrameCandidate {
  return { timestampSec, diffThumb: thumb(value) };
}

describe('meanPixelDifference', () => {
  it('is 0 for identical buffers', () => {
    expect(meanPixelDifference(thumb(50), thumb(50))).toBe(0);
  });

  it('is 1 for maximally different buffers', () => {
    expect(meanPixelDifference(thumb(0), thumb(255))).toBeCloseTo(1, 5);
  });

  it('throws on a mismatched buffer length', () => {
    expect(() => meanPixelDifference(Buffer.alloc(1), thumb(0))).toThrow();
  });
});

describe('selectFrameTimestamps', () => {
  it('returns nothing for zero candidates', () => {
    expect(selectFrameTimestamps([], 10)).toEqual([]);
  });

  it('returns the single candidate for a one-candidate clip, unconditionally', () => {
    // Even for a long clip, one candidate means the sampler found only one
    // decodable/distinguishable frame — a valid, honest result.
    expect(selectFrameTimestamps([candidate(0.5, 10)], 120)).toEqual([0.5]);
  });

  it('keeps a candidate whose difference from the last retained clears the threshold', () => {
    // 0 -> 40 -> 80 -> 255: each step differs enough from the previous
    // RETAINED frame to survive (well above DIFF_THRESHOLD).
    const candidates = [candidate(0, 0), candidate(1, 90), candidate(2, 180), candidate(3, 255)];
    const result = selectFrameTimestamps(candidates, 4);
    expect(result).toEqual([0, 1, 2, 3]);
  });

  it('drops a middle candidate too similar to the last retained one, but keeps a later one that clears it', () => {
    // 0 -> 10 (too close to 0, dropped) -> 255 (differs enough from the
    // last RETAINED value, 0, to survive on its own merits — nothing here
    // special-cases "last").
    const candidates = [candidate(0, 0), candidate(1, 10), candidate(2, 255)];
    const result = selectFrameTimestamps(candidates, 3);
    expect(result).toEqual([0, 2]);
  });

  it('downselects more than TARGET_FRAME_COUNT survivors, keeping the survivor list endpoints fixed', () => {
    // 10 alternating-extreme candidates all clear the diff threshold against
    // one another, so every one survives dedup — more than the target.
    const candidates: FrameCandidate[] = [];
    for (let i = 0; i < 10; i++) {
      candidates.push(candidate(i, i % 2 === 0 ? 0 : 255));
    }
    const result = selectFrameTimestamps(candidates, 10);
    expect(result.length).toBeLessThanOrEqual(TARGET_FRAME_COUNT);
    expect(result[0]).toBe(0);
    expect(result.at(-1)).toBe(9);
  });

  it('fills a visually-static, non-trivial clip from duration anchors', () => {
    // Every candidate is identical, so dedup collapses to the two
    // endpoints — but the clip is 10s long, well past the "trivial" floor,
    // so the result should be filled out with more than 2 timestamps.
    const candidates = [candidate(0, 10), candidate(5, 10), candidate(10, 10)];
    const result = selectFrameTimestamps(candidates, 10);
    expect(result.length).toBeGreaterThan(2);
    // Every anchor stays inside the clip's actual duration.
    for (const t of result) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(10);
    }
    // Ascending order — scenes must read chronologically.
    expect([...result].sort((a, b) => a - b)).toEqual(result);
  });

  it('does not pad a visually-static clip shorter than the non-trivial floor', () => {
    // A 1-second clip with two identical candidates collapses to the
    // single first frame — exactly the case a real static/very-short clip
    // produces — and stays that way: no anchor-fill below the floor.
    const candidates = [candidate(0, 10), candidate(1, 10)];
    const result = selectFrameTimestamps(candidates, 1);
    expect(result).toEqual([0]);
  });
});
