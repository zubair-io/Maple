/**
 * Pure unit tests for the reserved-tree guards (`.maple/` derivative cache,
 * `_duplicates/` quarantine). No Mongo, no fs — these always run. The
 * handleEvent-level integration behavior is covered in
 * `discover.events.test.ts`.
 */

import { describe, it, expect } from 'bun:test';
import {
  isInsideMapleCache,
  isInsideDuplicatesDir,
  refusesReservedTreeEvent,
} from './reserved-trees.ts';

const ROOT = '/lib/photos';

describe('isInsideMapleCache', () => {
  it('matches a .maple segment at any depth', () => {
    expect(isInsideMapleCache(ROOT, `${ROOT}/.maple/thumbs/x.jpg`)).toBe(true);
    expect(isInsideMapleCache(ROOT, `${ROOT}/sub/dir/.maple/previews/y.avif`)).toBe(true);
  });

  it('rejects paths outside the root and the root itself', () => {
    expect(isInsideMapleCache(ROOT, '/elsewhere/.maple/x.jpg')).toBe(false);
    expect(isInsideMapleCache(ROOT, ROOT)).toBe(false);
    expect(isInsideMapleCache(ROOT, `${ROOT}/photos/img.jpg`)).toBe(false);
  });

  it('is not defeated by a top-level directory named ..foo', () => {
    // path.relative yields "..foo/…" here, which a bare startsWith('..')
    // misreads as outside-the-root and skips the segment scan entirely.
    expect(isInsideMapleCache(ROOT, `${ROOT}/..foo/.maple/thumbs/x.jpg`)).toBe(true);
  });
});

describe('isInsideDuplicatesDir', () => {
  it('matches a _duplicates segment at any depth', () => {
    expect(isInsideDuplicatesDir(ROOT, `${ROOT}/_duplicates/photos/x.jpg`)).toBe(true);
    expect(isInsideDuplicatesDir(ROOT, `${ROOT}/sub/_duplicates/y.dng`)).toBe(true);
  });

  it('requires the exact segment, not a substring', () => {
    expect(isInsideDuplicatesDir(ROOT, `${ROOT}/my_duplicates/x.jpg`)).toBe(false);
    expect(isInsideDuplicatesDir(ROOT, `${ROOT}/_duplicates_old/x.jpg`)).toBe(false);
  });

  it('rejects paths outside the root', () => {
    expect(isInsideDuplicatesDir(ROOT, '/elsewhere/_duplicates/x.jpg')).toBe(false);
    expect(isInsideDuplicatesDir(ROOT, `${ROOT}/../_duplicates/x.jpg`)).toBe(false);
  });

  it('is not defeated by a top-level directory named ..foo', () => {
    expect(isInsideDuplicatesDir(ROOT, `${ROOT}/..foo/_duplicates/x.jpg`)).toBe(true);
  });
});

describe('refusesReservedTreeEvent', () => {
  it('refuses any kind whose absPath is inside a reserved tree', () => {
    for (const kind of ['created', 'modified', 'removed', 'renamed'] as const) {
      expect(refusesReservedTreeEvent({ kind, absPath: `${ROOT}/.maple/thumbs/x.jpg` }, ROOT)).toBe(
        true,
      );
      expect(refusesReservedTreeEvent({ kind, absPath: `${ROOT}/_duplicates/x.jpg` }, ROOT)).toBe(
        true,
      );
    }
  });

  it('refuses a rename whose fromPath is inside a reserved tree', () => {
    expect(
      refusesReservedTreeEvent(
        { kind: 'renamed', absPath: `${ROOT}/ok.jpg`, fromPath: `${ROOT}/_duplicates/ok.jpg` },
        ROOT,
      ),
    ).toBe(true);
    expect(
      refusesReservedTreeEvent(
        { kind: 'renamed', absPath: `${ROOT}/ok.jpg`, fromPath: `${ROOT}/.maple/ok.jpg` },
        ROOT,
      ),
    ).toBe(true);
  });

  it('passes ordinary events through', () => {
    expect(refusesReservedTreeEvent({ kind: 'created', absPath: `${ROOT}/img.dng` }, ROOT)).toBe(
      false,
    );
    expect(
      refusesReservedTreeEvent(
        { kind: 'renamed', absPath: `${ROOT}/b.dng`, fromPath: `${ROOT}/a.dng` },
        ROOT,
      ),
    ).toBe(false);
  });
});
