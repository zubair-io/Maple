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
  averageConfidence,
  bulkFailureLabel,
  bulkSuccessLabel,
  clusteringSummary,
  deletePersonConfirm,
  errorMessage,
  faceCropTransform,
  faceKey,
  filterNamed,
  hiddenFaceCount,
  isAutoNamed,
  peopleStats,
  pickSelectedFaces,
  selectAllKeys,
  sortPeople,
  toggleSelection,
  visibleFaces,
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

describe('faceCropTransform', () => {
  it('returns a scale + translate string in CSS units', () => {
    const bbox: Bbox = { x: 0.25, y: 0.5, w: 0.5, h: 0.5 };
    // 1 / 0.5 = 2 → scale(2). translate: -25%, -50%.
    expect(faceCropTransform(bbox)).toBe('scale(2) translate(-25%, -50%)');
  });

  it('clamps scale at >= 1 (no zooming OUT of a full-frame bbox)', () => {
    const bbox: Bbox = { x: 0, y: 0, w: 1, h: 1 };
    expect(faceCropTransform(bbox)).toBe('scale(1) translate(0%, 0%)');
  });

  it('clamps tiny bboxes at the 0.01 floor to avoid runaway scale', () => {
    const bbox: Bbox = { x: 0, y: 0, w: 0, h: 0 };
    // 1 / 0.01 = 100 — the floor stops a divide-by-zero blow-up.
    expect(faceCropTransform(bbox)).toBe('scale(100) translate(0%, 0%)');
  });

  it('takes the larger of the per-axis scales so the bbox fills the wrapper', () => {
    const bbox: Bbox = { x: 0, y: 0, w: 0.5, h: 0.25 };
    // scaleX = 2, scaleY = 4 → scale(4).
    expect(faceCropTransform(bbox)).toBe('scale(4) translate(0%, 0%)');
  });
});

// ── Copy / labels ─────────────────────────────────────────────────────────

describe('deletePersonConfirm', () => {
  it('pluralises faces honestly', () => {
    expect(deletePersonConfirm('Alice', 1)).toContain('1 face will become unassigned');
    expect(deletePersonConfirm('Alice', 4)).toContain('4 faces will become unassigned');
  });
});

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

// ── errorMessage ──────────────────────────────────────────────────────────

describe('errorMessage', () => {
  it('reads the inner Bun-shaped `{ error: { error: "…" } }` payload', () => {
    expect(errorMessage({ error: { error: 'boom' } })).toBe('boom');
  });

  it('reads a string `.error` field', () => {
    expect(errorMessage({ error: 'plain' })).toBe('plain');
  });

  it('reads Error.message', () => {
    expect(errorMessage(new Error('nope'))).toBe('nope');
  });

  it('falls back to String(err) for unknown shapes', () => {
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage('raw string')).toBe('raw string');
  });
});
