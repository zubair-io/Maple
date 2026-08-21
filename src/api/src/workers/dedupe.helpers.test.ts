/**
 * Pure unit tests for the DeDuplicate keeper-selection ranking and the
 * duplicate-location classifiers. No Mongo, no fs — these always run.
 */

import { describe, it, expect } from 'bun:test';
import { ObjectId } from 'mongodb';
import type { FileInfo } from '../db/schema.ts';
import {
  isUnsortedPath,
  isMiscPath,
  isNumberedCopy,
  isAllNumericPath,
  removalScore,
  selectKeeper,
  folderKey,
  sameEntry,
} from './dedupe.helpers.ts';

const LIB = new ObjectId();

function fi(path: string, filename: string, library = LIB): FileInfo {
  return { path, filename, library_id: library };
}

describe('classifiers', () => {
  it('isUnsortedPath matches any case / position', () => {
    expect(isUnsortedPath('unsorted')).toBe(true);
    expect(isUnsortedPath('photos/Unsorted/2024')).toBe(true);
    expect(isUnsortedPath('to_unsorted_dump')).toBe(true);
    expect(isUnsortedPath('')).toBe(false);
    expect(isUnsortedPath('photos/sorted/2024')).toBe(false);
  });

  it('isMiscPath matches a "misc" segment in any case, not substrings', () => {
    expect(isMiscPath('misc')).toBe(true);
    expect(isMiscPath('Misc')).toBe(true);
    expect(isMiscPath('photos/MISC/2024')).toBe(true);
    expect(isMiscPath('')).toBe(false);
    expect(isMiscPath('miscellaneous')).toBe(false); // segment match, not substring
    expect(isMiscPath('photos/misc-old')).toBe(false);
  });

  it('isNumberedCopy matches name.<digits>.<ext> only', () => {
    expect(isNumberedCopy('IMG_001.2.dng')).toBe(true);
    expect(isNumberedCopy('photo.10.jpg')).toBe(true);
    expect(isNumberedCopy('IMG_001.dng')).toBe(false); // plain file
    expect(isNumberedCopy('IMG_2024.dng')).toBe(false); // digits are the stem, not a copy index
    expect(isNumberedCopy('a.b.c.3.tiff')).toBe(true);
  });

  it('isAllNumericPath requires every segment all-digit and non-empty', () => {
    expect(isAllNumericPath('12345')).toBe(true);
    expect(isAllNumericPath('2024/01/05')).toBe(true);
    expect(isAllNumericPath('')).toBe(false); // root never counts
    expect(isAllNumericPath('2024/jan')).toBe(false);
    expect(isAllNumericPath('a/1')).toBe(false);
  });

  it('removalScore weights unsorted > misc > numbered > all-numeric and is additive', () => {
    expect(removalScore(fi('photos/2024', 'IMG.dng'))).toBe(0);
    expect(removalScore(fi('1234', 'IMG.dng'))).toBe(1); // all-numeric
    expect(removalScore(fi('photos', 'IMG.2.dng'))).toBe(2); // numbered copy
    expect(removalScore(fi('misc', 'IMG.dng'))).toBe(4); // misc folder
    expect(removalScore(fi('unsorted', 'IMG.dng'))).toBe(8); // unsorted
    // A single higher-priority match always outranks lower combinations
    // (8 > 4+2+1, 4 > 2+1).
    expect(removalScore(fi('unsorted', 'IMG.dng'))).toBeGreaterThan(
      removalScore(fi('misc/1234', 'IMG.2.dng')),
    );
    expect(removalScore(fi('misc', 'IMG.dng'))).toBeGreaterThan(
      removalScore(fi('1234', 'IMG.2.dng')),
    );
  });
});

describe('selectKeeper', () => {
  it('rule 4: with no signals, keeps the LAST entry in the list', () => {
    const entries = [fi('a', 'IMG.dng'), fi('b', 'IMG.dng'), fi('c', 'IMG.dng')];
    expect(selectKeeper(entries)).toBe(entries[2]);
  });

  it('rule 1: moves the unsorted copy, keeps the clean one', () => {
    const clean = fi('photos/2024', 'IMG.dng');
    const entries = [clean, fi('unsorted', 'IMG.dng')];
    expect(selectKeeper(entries)).toBe(clean);
  });

  it('rule 2: keeps the plain file over a numbered copy', () => {
    const plain = fi('photos', 'IMG_001.dng');
    const entries = [fi('photos', 'IMG_001.2.dng'), plain];
    expect(selectKeeper(entries)).toBe(plain);
  });

  it('rule 3: keeps the named-folder copy over an all-numeric path', () => {
    const named = fi('vacation', 'IMG.dng');
    const entries = [named, fi('100/200', 'IMG.dng')];
    expect(selectKeeper(entries)).toBe(named);
  });

  it('misc rule: moves the Misc copy, keeps the clean one', () => {
    const clean = fi('photos/2024', 'IMG.dng');
    const entries = [clean, fi('Misc', 'IMG.dng')];
    expect(selectKeeper(entries)).toBe(clean);
  });

  it('priority order: unsorted is moved before a misc copy', () => {
    // Both are dump-folder signals, but unsorted (8) outranks misc (4): the
    // misc copy is the lesser evil and is KEPT.
    const misc = fi('misc', 'IMG.dng');
    const entries = [fi('unsorted', 'IMG.dng'), misc];
    expect(selectKeeper(entries)).toBe(misc);
  });

  it('priority order: unsorted is moved before a numbered copy', () => {
    // Both are "disposable", but unsorted (4) outranks numbered (2): the
    // numbered copy is the lesser evil and is KEPT.
    const numbered = fi('photos', 'IMG.2.dng');
    const entries = [fi('unsorted', 'IMG.dng'), numbered];
    expect(selectKeeper(entries)).toBe(numbered);
  });

  it('tie among equally-clean copies keeps the last', () => {
    const last = fi('b/clean', 'IMG.dng');
    const entries = [fi('a/clean', 'IMG.dng'), last];
    expect(selectKeeper(entries)).toBe(last);
  });
});

describe('folderKey / sameEntry', () => {
  it('folderKey ignores filename, distinguishes library + dir', () => {
    expect(folderKey(fi('a/b', 'x.dng'))).toBe(folderKey(fi('a/b', 'y.dng')));
    expect(folderKey(fi('a/b', 'x.dng'))).not.toBe(folderKey(fi('a/c', 'x.dng')));
    const other = new ObjectId();
    expect(folderKey(fi('a/b', 'x.dng'))).not.toBe(folderKey(fi('a/b', 'x.dng', other)));
  });

  it('sameEntry matches the full (library, path, filename) tuple', () => {
    expect(sameEntry(fi('a', 'x.dng'), fi('a', 'x.dng'))).toBe(true);
    expect(sameEntry(fi('a', 'x.dng'), fi('a', 'y.dng'))).toBe(false);
    expect(sameEntry(fi('a', 'x.dng'), fi('b', 'x.dng'))).toBe(false);
  });
});
