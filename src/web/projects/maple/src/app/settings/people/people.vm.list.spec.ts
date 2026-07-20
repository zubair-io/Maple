// Tests for the people-LIST derivation half of `people.vm.ts`: auto-name
// detection, the stats line, list ordering, and the list filters.
//
// Split out of `people.vm.spec.ts` to keep both files under the 600-LOC
// file-budget gate (mirrors the `people.store.hide.spec.ts` split).

import { describe, it, expect } from 'vitest';
import type { ApiPerson } from '@maple-common';
import {
  AUTO_NAME_RE,
  filterNamed,
  filterSmallClusters,
  isAutoNamed,
  peopleStats,
  SMALL_CLUSTER_MIN_FACES,
  sortPeople,
} from './people.vm';

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

  it('sorts named clusters by descending face count', () => {
    const rows = [
      person({ id: '1', name: 'Alice', faceCount: 4 }),
      person({ id: '2', name: 'Bob', faceCount: 91 }),
      person({ id: '3', name: 'Cara', faceCount: 17 }),
    ];
    const sorted = sortPeople(rows);
    expect(sorted.map((p) => p.id)).toEqual(['2', '3', '1']);
  });

  it('tiebreaks equal-face-count named clusters alphabetically, case/accent-insensitive', () => {
    // All four share the fixture's default faceCount, so the name tiebreak decides.
    const rows = [
      person({ id: '1', name: 'Charlie' }),
      person({ id: '2', name: 'alice' }),
      person({ id: '3', name: 'Bob' }),
      person({ id: '4', name: 'Émile' }),
    ];
    const sorted = sortPeople(rows);
    expect(sorted.map((p) => p.name.toLowerCase())).toEqual(['alice', 'bob', 'charlie', 'émile']);
  });

  it('still puts every named cluster before auto-named ones, even with far fewer faces', () => {
    const rows = [
      person({ id: '1', name: 'Person 5', faceCount: 900 }),
      person({ id: '2', name: 'Alice', faceCount: 2 }),
    ];
    const sorted = sortPeople(rows);
    expect(sorted.map((p) => p.id)).toEqual(['2', '1']);
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

// ── filterSmallClusters ────────────────────────────────────────────────────

describe('filterSmallClusters', () => {
  it('keeps rows at or above the floor and drops the ones below it', () => {
    const rows = [
      person({ id: '1', name: 'Alice', faceCount: 20 }),
      person({ id: '2', name: 'Bob', faceCount: 19 }),
      person({ id: '3', name: 'Cara', faceCount: 400 }),
      person({ id: '4', name: 'Person 9', faceCount: 1 }),
    ];
    // Boundary is inclusive: exactly `min` faces stays visible.
    expect(filterSmallClusters(rows, 20).map((p) => p.id)).toEqual(['1', '3']);
  });

  it('is a no-op when every row clears the floor, and does not mutate its input', () => {
    const rows = [person({ id: '1', faceCount: 50 }), person({ id: '2', faceCount: 21 })];
    const snapshot = rows.map((p) => p.id);
    expect(filterSmallClusters(rows, 20).map((p) => p.id)).toEqual(['1', '2']);
    expect(rows.map((p) => p.id)).toEqual(snapshot);
  });

  it('can hide everything when no row clears the floor', () => {
    const rows = [person({ id: '1', faceCount: 3 }), person({ id: '2', faceCount: 19 })];
    expect(filterSmallClusters(rows, SMALL_CLUSTER_MIN_FACES)).toEqual([]);
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
