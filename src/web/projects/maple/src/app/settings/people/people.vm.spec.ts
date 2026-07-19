// Tests for the pure VM module behind `people.component.ts`.
//
// Lives next to the component per the `*.vm.ts` co-location pattern
// (#190, slice 3). These tests pull plain functions, build minimal
// fixtures, and assert behaviour without spinning up TestBed — that's
// the whole point of the split.

import { describe, it, expect } from 'vitest';
import type { ApiPerson, ApiPersonDetail, ApiPersonFace, Bbox } from '@maple-common';
import {
  AUTO_NAME_RE,
  PEOPLE_GRID,
  averageConfidence,
  bulkFailureLabel,
  bulkSuccessLabel,
  chunkPeopleRows,
  clusteringSummary,
  faceCropTransform,
  faceKey,
  filterNamed,
  hiddenFaceCount,
  isAutoNamed,
  mergePeopleConfirm,
  mergeTargets,
  peopleCardWidth,
  peopleGridColumns,
  peopleRowHeight,
  peopleRowKey,
  peopleStats,
  pickSelectedFaces,
  selectAllKeys,
  sortPeople,
  toggleKey,
  toggleSelection,
  visibleFaces,
  withNaturalDims,
} from './people.vm';

// ── Fixture builders ───────────────────────────────────────────────────────

function person(overrides: Partial<ApiPerson> = {}): ApiPerson {
  return {
    id: 'p1',
    name: 'Alice',
    faceCount: 10,
    coverAssetId: 'a1',
    coverAbsPath: '/x/a1.jpg',
    coverBbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    hasMergeSuggestion: false,
    ...overrides,
  };
}

function face(overrides: Partial<ApiPersonFace> = {}): ApiPersonFace {
  return {
    assetId: 'asset-1',
    faceIndex: 0,
    absPath: '/x/asset-1.jpg',
    bbox: { x: 0, y: 0, w: 0.5, h: 0.5 },
    confidence: 0.8,
    ...overrides,
  };
}

function detail(faces: ApiPersonFace[], overrides: Partial<ApiPersonDetail> = {}): ApiPersonDetail {
  return {
    id: 'p1',
    name: 'Alice',
    coverAssetId: 'a1',
    coverBbox: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    faces,
    suggestedMerge: null,
    ...overrides,
  };
}

// ── isAutoNamed / AUTO_NAME_RE ─────────────────────────────────────────────

describe('isAutoNamed', () => {
  it('matches the strict "Person N" pattern', () => {
    expect(isAutoNamed('Person 1')).toBe(true);
    expect(isAutoNamed('Person 12345')).toBe(true);
  });

  it('does not match operator-named clusters that happen to start with "Person "', () => {
    // The loose `startsWith` heuristic would miscategorise this — the
    // anchored regex is the whole point.
    expect(isAutoNamed('Person Alice')).toBe(false);
    expect(isAutoNamed('Person 1 (test)')).toBe(false);
  });

  it('rejects unrelated strings', () => {
    expect(isAutoNamed('Alice')).toBe(false);
    expect(isAutoNamed('')).toBe(false);
    expect(isAutoNamed('Personne 1')).toBe(false);
  });

  it('exports the regex for documentation / parity', () => {
    expect(AUTO_NAME_RE.test('Person 42')).toBe(true);
  });
});

// ── peopleStats ────────────────────────────────────────────────────────────

describe('peopleStats', () => {
  it('counts named, unnamed, and total faces', () => {
    const rows = [
      person({ id: '1', name: 'Alice', faceCount: 4 }),
      person({ id: '2', name: 'Bob', faceCount: 2 }),
      person({ id: '3', name: 'Person 1', faceCount: 10 }),
      person({ id: '4', name: 'Person 12', faceCount: 5 }),
    ];
    expect(peopleStats(rows)).toEqual({ named: 2, unnamed: 2, faces: 21 });
  });

  it('returns zeros for an empty list', () => {
    expect(peopleStats([])).toEqual({ named: 0, unnamed: 0, faces: 0 });
  });
});

// ── sortPeople ─────────────────────────────────────────────────────────────

describe('sortPeople', () => {
  it('puts named clusters before auto-named ones', () => {
    const rows = [
      person({ id: '1', name: 'Person 5', faceCount: 1 }),
      person({ id: '2', name: 'Alice', faceCount: 1 }),
    ];
    const sorted = sortPeople(rows);
    expect(sorted.map((p) => p.id)).toEqual(['2', '1']);
  });

  it('sorts named clusters alphabetically, case/accent-insensitive', () => {
    const rows = [
      person({ id: '1', name: 'Charlie' }),
      person({ id: '2', name: 'alice' }),
      person({ id: '3', name: 'Bob' }),
      person({ id: '4', name: 'Émile' }),
    ];
    const sorted = sortPeople(rows);
    expect(sorted.map((p) => p.name.toLowerCase())).toEqual(['alice', 'bob', 'charlie', 'émile']);
  });

  it('sorts auto-named clusters by descending face count', () => {
    const rows = [
      person({ id: '1', name: 'Person 1', faceCount: 3 }),
      person({ id: '2', name: 'Person 2', faceCount: 9 }),
      person({ id: '3', name: 'Person 3', faceCount: 5 }),
    ];
    const sorted = sortPeople(rows);
    expect(sorted.map((p) => p.id)).toEqual(['2', '3', '1']);
  });

  it('tiebreaks equal-face-count auto-named clusters by id (stable order)', () => {
    const rows = [
      person({ id: 'zzz', name: 'Person 7', faceCount: 4 }),
      person({ id: 'aaa', name: 'Person 8', faceCount: 4 }),
    ];
    const sorted = sortPeople(rows);
    expect(sorted.map((p) => p.id)).toEqual(['aaa', 'zzz']);
  });

  it('does not mutate its input', () => {
    const rows = [person({ id: '1', name: 'Bob' }), person({ id: '2', name: 'Alice' })];
    const snapshot = rows.map((p) => p.id).join(',');
    sortPeople(rows);
    expect(rows.map((p) => p.id).join(',')).toBe(snapshot);
  });
});

// ── filterNamed ────────────────────────────────────────────────────────────

describe('filterNamed', () => {
  it('drops auto-named clusters', () => {
    const rows = [
      person({ id: '1', name: 'Alice' }),
      person({ id: '2', name: 'Person 1' }),
      person({ id: '3', name: 'Bob' }),
    ];
    expect(filterNamed(rows).map((p) => p.id)).toEqual(['1', '3']);
  });
});

// ── visibleFaces ───────────────────────────────────────────────────────────

describe('visibleFaces', () => {
  it('filters by threshold and sorts high-confidence-first', () => {
    const faces = [
      face({ faceIndex: 0, confidence: 0.4 }),
      face({ faceIndex: 1, confidence: 0.95 }),
      face({ faceIndex: 2, confidence: 0.7 }),
      face({ faceIndex: 3, confidence: 0.59 }),
    ];
    const out = visibleFaces(faces, 60);
    expect(out.map((f) => f.faceIndex)).toEqual([1, 2]);
  });

  it('threshold is percent — 0 keeps everything, 100 drops everything below full-confidence', () => {
    const faces = [face({ confidence: 0.999 }), face({ confidence: 0.5 })];
    expect(visibleFaces(faces, 0)).toHaveLength(2);
    expect(visibleFaces(faces, 100)).toHaveLength(0);
  });

  it('returns an empty array for empty input', () => {
    expect(visibleFaces([], 50)).toEqual([]);
  });
});

// ── hiddenFaceCount ───────────────────────────────────────────────────────

describe('hiddenFaceCount', () => {
  it('returns the count excluded by the threshold', () => {
    const faces = [
      face({ confidence: 0.9 }),
      face({ confidence: 0.4 }),
      face({ confidence: 0.55 }),
    ];
    expect(hiddenFaceCount(faces, 60)).toBe(2);
  });

  it('returns 0 when nothing is hidden', () => {
    expect(hiddenFaceCount([face({ confidence: 0.9 })], 50)).toBe(0);
  });
});

// ── averageConfidence ─────────────────────────────────────────────────────

describe('averageConfidence', () => {
  it('returns the rounded mean as a percent', () => {
    const faces = [face({ confidence: 0.8 }), face({ confidence: 0.6 }), face({ confidence: 0.7 })];
    expect(averageConfidence(faces)).toBe(70);
  });

  it('returns 0 for an empty list (rather than NaN)', () => {
    expect(averageConfidence([])).toBe(0);
  });
});

// ── faceKey / selection plumbing ──────────────────────────────────────────

describe('faceKey', () => {
  it('joins assetId + faceIndex with a colon', () => {
    expect(faceKey({ assetId: 'abc', faceIndex: 2 })).toBe('abc:2');
  });
});

describe('selectAllKeys', () => {
  it('builds a Set covering every face', () => {
    const faces = [
      face({ assetId: 'a', faceIndex: 0 }),
      face({ assetId: 'a', faceIndex: 1 }),
      face({ assetId: 'b', faceIndex: 0 }),
    ];
    const out = selectAllKeys(faces);
    expect(out.size).toBe(3);
    expect(out.has('a:0')).toBe(true);
    expect(out.has('b:0')).toBe(true);
  });
});

describe('toggleSelection', () => {
  it('adds an unselected face', () => {
    const out = toggleSelection(new Set(['x:0']), { assetId: 'y', faceIndex: 1 });
    expect(out.has('x:0')).toBe(true);
    expect(out.has('y:1')).toBe(true);
  });

  it('removes a selected face', () => {
    const out = toggleSelection(new Set(['x:0', 'y:1']), { assetId: 'y', faceIndex: 1 });
    expect(out.has('y:1')).toBe(false);
    expect(out.has('x:0')).toBe(true);
  });

  it('returns a new Set (does not mutate the input)', () => {
    const input = new Set(['x:0']);
    const out = toggleSelection(input, { assetId: 'y', faceIndex: 1 });
    expect(out).not.toBe(input);
    expect(input.has('y:1')).toBe(false);
  });
});

describe('pickSelectedFaces', () => {
  it('returns the live face objects matching the selection', () => {
    const faces = [
      face({ assetId: 'a', faceIndex: 0 }),
      face({ assetId: 'a', faceIndex: 1 }),
      face({ assetId: 'b', faceIndex: 0 }),
    ];
    const out = pickSelectedFaces(detail(faces), new Set(['a:1', 'b:0']));
    expect(out.map((f) => `${f.assetId}:${f.faceIndex}`)).toEqual(['a:1', 'b:0']);
  });

  it('drops stale keys silently', () => {
    const faces = [face({ assetId: 'a', faceIndex: 0 })];
    const out = pickSelectedFaces(detail(faces), new Set(['a:0', 'gone:99']));
    expect(out).toHaveLength(1);
  });

  it('returns an empty array when no detail is open', () => {
    expect(pickSelectedFaces(null, new Set(['a:0']))).toEqual([]);
  });
});

// ── faceCropTransform ─────────────────────────────────────────────────────

/** Parse `scale(s) translate(tx%, ty%)` back into numbers so tests can
 * assert on properties (bbox centre lands at 50%, scale > 1) rather than
 * eyeballing JS's float-formatting quirks. */
function parseTransform(s: string): { scale: number; tx: number; ty: number } {
  const m = s.match(/^scale\(([^)]+)\) translate\(([^%]+)%, ([^%]+)%\)$/);
  if (!m) throw new Error(`unparseable transform: ${s}`);
  return { scale: Number(m[1]), tx: Number(m[2]), ty: Number(m[3]) };
}

describe('faceCropTransform', () => {
  it('centres a square bbox after 25% padding', () => {
    // Padded bbox (0.125, 0.125, 0.75, 0.75). scale = 1/0.75. translate
    // keeps the bbox centre at the wrapper centre.
    const bbox: Bbox = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const t = parseTransform(faceCropTransform(bbox));
    expect(t.scale).toBeCloseTo(4 / 3);
    expect(t.tx).toBeCloseTo(-12.5);
    expect(t.ty).toBeCloseTo(-12.5);
  });

  it("clamps full-frame bbox at scale 1 (padding can't spill past [0,1])", () => {
    const bbox: Bbox = { x: 0, y: 0, w: 1, h: 1 };
    expect(faceCropTransform(bbox)).toBe('scale(1) translate(0%, 0%)');
  });

  it('clamps tiny bboxes at the 0.01 floor to avoid runaway scale', () => {
    const bbox: Bbox = { x: 0, y: 0, w: 0, h: 0 };
    // After 25% padding, w and h are still 0 → max(0.01, 0) = 0.01 floor.
    // scale = 100. translate: 0.5/100 - 0 - 0 = 0.005 → 0.5%.
    expect(faceCropTransform(bbox)).toBe('scale(100) translate(0.5%, 0.5%)');
  });

  it('takes the larger axis when bbox aspect ≠ wrapper aspect', () => {
    // Padded bbox: w=0.625 (clamped at right edge), h=0.3125.
    // scale = 1/0.625 = 1.6 (the larger axis fills the wrapper).
    const bbox: Bbox = { x: 0, y: 0, w: 0.5, h: 0.25 };
    expect(faceCropTransform(bbox)).toBe('scale(1.6) translate(0%, 15.625%)');
  });

  it('undoes the object-fit:cover letterbox on a non-square source', () => {
    // Same source-normalised bbox on a 3:2 landscape thumbnail. With
    // `object-fit: cover` the cover crop maps the source's 0..1 vertical
    // range into the element's 0..1 height and the 0..aspect horizontal
    // range into the same 0..1 element width — so a horizontally-centred
    // bbox at x=0.5 still ends up at element-x=0.5, but its element-width
    // grows by `aspect` (1.5 for 3:2). The bbox therefore occupies more
    // of the visible area, so we zoom LESS to make it fill the wrapper.
    const bbox: Bbox = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
    const square = parseTransform(faceCropTransform(bbox));
    const landscape = parseTransform(faceCropTransform(bbox, { nw: 600, nh: 400 }));
    expect(landscape.scale).toBeLessThan(square.scale);
    // The translates differ because the aspect-aware path moves the
    // bbox centre in element-space coords, not source-normalised coords.
    expect(landscape.tx).not.toBe(square.tx);
  });

  it('handles portrait sources symmetrically to landscape', () => {
    const bbox: Bbox = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
    const portrait = parseTransform(faceCropTransform(bbox, { nw: 400, nh: 600 }));
    expect(portrait.scale).toBeGreaterThan(1);
  });

  it('treats a missing or null naturalDims as the aspect-naïve fallback', () => {
    const bbox: Bbox = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
    expect(faceCropTransform(bbox)).toBe(faceCropTransform(bbox, null));
    expect(faceCropTransform(bbox)).toBe(faceCropTransform(bbox, undefined));
  });

  it('ignores degenerate naturalDims (zero-sized image)', () => {
    const bbox: Bbox = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
    expect(faceCropTransform(bbox, { nw: 0, nh: 600 })).toBe(faceCropTransform(bbox));
    expect(faceCropTransform(bbox, { nw: 600, nh: 0 })).toBe(faceCropTransform(bbox));
  });
});

// ── Copy / labels ─────────────────────────────────────────────────────────

describe('clusteringSummary', () => {
  it('handles zero assignments', () => {
    expect(clusteringSummary({ assigned: 0, newPeople: 0 })).toBe('No new faces to assign.');
  });

  it('pluralises faces and persons', () => {
    expect(clusteringSummary({ assigned: 1, newPeople: 1 })).toBe(
      'Assigned 1 face to 1 new person.',
    );
    expect(clusteringSummary({ assigned: 5, newPeople: 2 })).toBe(
      'Assigned 5 faces to 2 new persons.',
    );
  });
});

describe('bulkSuccessLabel', () => {
  it('pluralises by count, drives by verb', () => {
    expect(bulkSuccessLabel('Moved', 1)).toBe('Moved 1 face.');
    expect(bulkSuccessLabel('Moved', 3)).toBe('Moved 3 faces.');
    expect(bulkSuccessLabel('Hid', 7)).toBe('Hid 7 faces.');
  });
});

describe('bulkFailureLabel', () => {
  it('embeds the first rejection reason', () => {
    expect(bulkFailureLabel(2, 'timeout')).toBe('2 faces failed: timeout');
    expect(bulkFailureLabel(1, 'boom')).toBe('1 face failed: boom');
  });
});

describe('toggleKey', () => {
  it('adds a missing key and removes a present one, immutably', () => {
    const a = toggleKey(new Set<string>(), 'x');
    expect([...a]).toEqual(['x']);
    const b = toggleKey(a, 'x');
    expect([...b]).toEqual([]);
    expect([...a]).toEqual(['x']); // original set untouched
  });
});

describe('mergeTargets', () => {
  const mk = (id: string, name: string): ApiPerson => ({
    id,
    name,
    faceCount: 0,
    coverAssetId: null,
    coverAbsPath: null,
    coverBbox: null,
    createdAt: '',
    updatedAt: '',
    hasMergeSuggestion: false,
  });
  it('returns named people minus the excluded ids', () => {
    const named = [mk('1', 'Alice'), mk('2', 'Bob'), mk('3', 'Cara')];
    const out = mergeTargets(named, new Set(['2']));
    expect(out.map((p) => p.id)).toEqual(['1', '3']);
  });
});

describe('mergePeopleConfirm', () => {
  it('pluralises the subject count', () => {
    expect(mergePeopleConfirm(1, 'Alice')).toContain('1 person into "Alice"');
    expect(mergePeopleConfirm(3, 'Alice')).toContain('3 people into "Alice"');
  });
});

// ── Virtual-scroll row packing ──────────────────────────────────────────────
//
// These helpers drive the `cdk-virtual-scroll-viewport` windowing on the
// People list and were never exercised in a browser, so the unit coverage is
// the only guarantee the packing math agrees with the rendered grid (gap,
// card width, row height, chunking).

describe('peopleGridColumns', () => {
  it('returns the largest whole column count whose cards + gaps fit the width', () => {
    // minCardW 180, GAP 12. floor((width + GAP) / (minCardW + GAP)).
    // width 900: floor(912 / 192) = 4.
    expect(peopleGridColumns(900)).toBe(4);
    // width 600: floor(612 / 192) = 3.
    expect(peopleGridColumns(600)).toBe(3);
  });

  it('honours a custom min card width (narrow-viewport density)', () => {
    // minCardW 140, GAP 12 → (140 + 12) = 152. width 600: floor(612 / 152) = 4.
    expect(peopleGridColumns(600, 140)).toBe(4);
  });

  it('clamps to at least one column for narrow / zero / negative widths', () => {
    // A container narrower than one card still gets a single column.
    expect(peopleGridColumns(100)).toBe(1);
    expect(peopleGridColumns(0)).toBe(1);
    expect(peopleGridColumns(-50)).toBe(1);
  });

  it('fits exactly one column when the width equals a single min card', () => {
    expect(peopleGridColumns(PEOPLE_GRID.MIN_CARD_W)).toBe(1);
  });
});

describe('peopleCardWidth', () => {
  it('stretches cards to fill the row (the `1fr` behaviour), netting the gaps', () => {
    // 4 cols in 900px: (900 - 3*12) / 4 = 864 / 4 = 216.
    expect(peopleCardWidth(900, 4)).toBe(216);
  });

  it('equals the full width for a single column (no inter-card gap)', () => {
    expect(peopleCardWidth(500, 1)).toBe(500);
  });

  it('falls back to the min card width for non-positive cols / width', () => {
    expect(peopleCardWidth(900, 0)).toBe(PEOPLE_GRID.MIN_CARD_W);
    expect(peopleCardWidth(0, 4)).toBe(PEOPLE_GRID.MIN_CARD_W);
  });
});

describe('peopleRowHeight', () => {
  it('is the (rounded) card side + meta footer + one bottom gap', () => {
    // This MUST stay equal to cardWidth + META_H + GAP — the `[style.gap.px]` /
    // `[style.margin-bottom.px]` template bindings use the same GAP, so the
    // viewport `itemSize` and the rendered row spacing can't drift.
    const cardW = 216;
    expect(peopleRowHeight(cardW)).toBe(Math.round(cardW + PEOPLE_GRID.META_H + PEOPLE_GRID.GAP));
  });

  it('rounds fractional card widths to a whole pixel', () => {
    const cardW = 215.4;
    expect(peopleRowHeight(cardW)).toBe(Math.round(cardW + PEOPLE_GRID.META_H + PEOPLE_GRID.GAP));
    expect(Number.isInteger(peopleRowHeight(cardW))).toBe(true);
  });
});

describe('chunkPeopleRows', () => {
  const rows = (n: number): ApiPerson[] =>
    Array.from({ length: n }, (_, i) => person({ id: `p${i}`, name: `P${i}` }));

  it('chunks an exact multiple into full rows', () => {
    const out = chunkPeopleRows(rows(6), 3);
    expect(out.map((r) => r.length)).toEqual([3, 3]);
    expect(out[0].map((p) => p.id)).toEqual(['p0', 'p1', 'p2']);
    expect(out[1].map((p) => p.id)).toEqual(['p3', 'p4', 'p5']);
  });

  it('leaves a short ragged last row', () => {
    const out = chunkPeopleRows(rows(7), 3);
    expect(out.map((r) => r.length)).toEqual([3, 3, 1]);
    expect(out[2].map((p) => p.id)).toEqual(['p6']);
  });

  it('returns no rows for an empty input', () => {
    expect(chunkPeopleRows([], 4)).toEqual([]);
  });

  it('treats a non-positive column count as one column rather than looping forever', () => {
    const out = chunkPeopleRows(rows(3), 0);
    expect(out.map((r) => r.length)).toEqual([1, 1, 1]);
  });
});

describe('peopleRowKey', () => {
  it('keys a packed row off its first card id (survives re-packs of the head item)', () => {
    expect(peopleRowKey(0, [person({ id: 'p3' }), person({ id: 'p4' })])).toBe('p3');
  });

  it('falls back to the index for an empty row', () => {
    expect(peopleRowKey(2, [])).toBe('r2');
  });
});

describe('withNaturalDims', () => {
  it('records dimensions for a new url, never mutating the input map', () => {
    const cur = new Map();
    const next = withNaturalDims(cur, '/a.jpg', 800, 600);
    expect(next).not.toBe(cur);
    expect(cur.size).toBe(0);
    expect(next.get('/a.jpg')).toEqual({ nw: 800, nh: 600 });
  });

  it('returns the SAME map reference when the url already holds those dims', () => {
    const cur = new Map([['/a.jpg', { nw: 800, nh: 600 }]]);
    expect(withNaturalDims(cur, '/a.jpg', 800, 600)).toBe(cur);
  });

  it('updates when the dims differ for an existing url', () => {
    const cur = new Map([['/a.jpg', { nw: 800, nh: 600 }]]);
    const next = withNaturalDims(cur, '/a.jpg', 1024, 768);
    expect(next).not.toBe(cur);
    expect(next.get('/a.jpg')).toEqual({ nw: 1024, nh: 768 });
  });

  it('ignores zero / negative dimensions (unloaded or broken images)', () => {
    const cur = new Map();
    expect(withNaturalDims(cur, '/a.jpg', 0, 600)).toBe(cur);
    expect(withNaturalDims(cur, '/a.jpg', 800, 0)).toBe(cur);
    expect(withNaturalDims(cur, '/a.jpg', -1, -1)).toBe(cur);
  });
});
