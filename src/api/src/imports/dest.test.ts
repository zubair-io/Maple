/**
 * Pure unit tests for the imports destination-layout helpers. No Mongo, no
 * filesystem — these are the layout/safety primitives PR #1 ships.
 *
 * Layout target (ticket #742):
 *   override:      <YEAR>/<label>/<filename>
 *   default:       <YEAR>/misc/<source-folder>/<filename>
 *   shot-folder:   <YEAR>/<parent-folder>/<source-folder>/<filename>
 *   nearby-match:  <existing-asset-folder>/<filename>
 * Bucketing basis: file mtime, UTC (parity with backup/path-formatter.ts).
 */

import { describe, test, expect } from 'bun:test';
import {
  bucketForMtime,
  isSafeLabel,
  isNumberedShotFolder,
  destRelPath,
  destRelPathDefault,
  destRelPathShotFolder,
  destRelPathInFolder,
} from './dest.ts';

const NUL = String.fromCharCode(0);
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

/** Helper: epoch-ms for a UTC wall-clock instant. */
function utc(y: number, m: number, d: number, hh = 0, mm = 0): number {
  return Date.UTC(y, m - 1, d, hh, mm, 0, 0);
}

describe('bucketForMtime', () => {
  test('returns 4-digit year and 2-digit month from UTC mtime', () => {
    expect(bucketForMtime(utc(2024, 3, 9))).toEqual({ year: '2024', mm: '03' });
    expect(bucketForMtime(utc(2007, 11, 25))).toEqual({
      year: '2007',
      mm: '11',
    });
  });

  test('pads single-digit months', () => {
    expect(bucketForMtime(utc(2024, 1, 1)).mm).toBe('01');
    expect(bucketForMtime(utc(2024, 9, 30)).mm).toBe('09');
  });

  test('buckets by UTC, not local time, at a day boundary', () => {
    // 2023-12-31 23:30 UTC stays in December 2023 regardless of host TZ.
    const b = bucketForMtime(utc(2023, 12, 31, 23, 30));
    expect(b).toEqual({ year: '2023', mm: '12' });
  });

  test('handles year rollover and leap day', () => {
    expect(bucketForMtime(utc(2024, 2, 29))).toEqual({
      year: '2024',
      mm: '02',
    });
    expect(bucketForMtime(utc(2025, 1, 1))).toEqual({ year: '2025', mm: '01' });
  });
});

describe('isSafeLabel', () => {
  test('accepts the default MM label and ordinary free text', () => {
    expect(isSafeLabel('03')).toBe(true);
    expect(isSafeLabel('Vacation 2024')).toBe(true);
    expect(isSafeLabel('March — Iceland')).toBe(true);
    expect(isSafeLabel('a')).toBe(true);
    expect(isSafeLabel('a b')).toBe(true); // internal spaces are fine
  });

  test('rejects path separators', () => {
    expect(isSafeLabel('a/b')).toBe(false);
    expect(isSafeLabel('a\\b')).toBe(false);
  });

  test('rejects traversal and dot segments', () => {
    expect(isSafeLabel('..')).toBe(false);
    expect(isSafeLabel('.')).toBe(false);
    expect(isSafeLabel('.hidden')).toBe(false);
    expect(isSafeLabel('../escape')).toBe(false);
  });

  test('rejects empty, whitespace-only, and over-long labels', () => {
    expect(isSafeLabel('')).toBe(false);
    expect(isSafeLabel('   ')).toBe(false);
    expect(isSafeLabel('x'.repeat(256))).toBe(false);
  });

  test('rejects NUL and control characters', () => {
    expect(isSafeLabel('a' + NUL + 'b')).toBe(false);
    expect(isSafeLabel('a' + NL + 'b')).toBe(false);
    expect(isSafeLabel('a' + TAB + 'b')).toBe(false);
  });
});

describe('destRelPath', () => {
  test('assembles <year>/<label>/<filename>', () => {
    expect(destRelPath({ year: '2024', label: '03', filename: 'IMG_0001.dng' })).toBe(
      '2024/03/IMG_0001.dng',
    );
    expect(
      destRelPath({
        year: '2024',
        label: 'Vacation 2024',
        filename: 'IMG_0001.dng',
      }),
    ).toBe('2024/Vacation 2024/IMG_0001.dng');
  });

  test('throws on an unsafe label', () => {
    expect(() => destRelPath({ year: '2024', label: '../etc', filename: 'a.dng' })).toThrow();
  });

  test('throws on an unsafe filename', () => {
    expect(() => destRelPath({ year: '2024', label: '03', filename: '../a.dng' })).toThrow();
    expect(() => destRelPath({ year: '2024', label: '03', filename: 'a/b.dng' })).toThrow();
  });
});

describe('isNumberedShotFolder', () => {
  test('matches anonymous camera dump-folder names', () => {
    expect(isNumberedShotFolder('Shot0123')).toBe(true);
    expect(isNumberedShotFolder('shot0456')).toBe(true);
    expect(isNumberedShotFolder('0123')).toBe(true);
    expect(isNumberedShotFolder('012')).toBe(true);
  });

  test('does not match meaningful folder names', () => {
    expect(isNumberedShotFolder('Vacation 2024')).toBe(false);
    expect(isNumberedShotFolder('IMG_0123')).toBe(false);
    expect(isNumberedShotFolder('DCIM')).toBe(false);
  });
});

describe('destRelPathDefault', () => {
  test('assembles <year>/misc/<folderName>/<filename>', () => {
    expect(
      destRelPathDefault({ year: '2024', folderName: 'Family Trip', filename: 'IMG_0001.dng' }),
    ).toBe('2024/misc/Family Trip/IMG_0001.dng');
  });

  test('throws on an unsafe folder name or filename', () => {
    expect(() =>
      destRelPathDefault({ year: '2024', folderName: '../etc', filename: 'a.dng' }),
    ).toThrow();
    expect(() =>
      destRelPathDefault({ year: '2024', folderName: 'ok', filename: '../a.dng' }),
    ).toThrow();
  });
});

describe('destRelPathShotFolder', () => {
  test('assembles <year>/<parentFolderName>/<folderName>/<filename>', () => {
    expect(
      destRelPathShotFolder({
        year: '2024',
        parentFolderName: 'DCIM',
        folderName: '0123',
        filename: 'IMG_0001.dng',
      }),
    ).toBe('2024/DCIM/0123/IMG_0001.dng');
  });

  test('throws on an unsafe parent folder name', () => {
    expect(() =>
      destRelPathShotFolder({
        year: '2024',
        parentFolderName: '../etc',
        folderName: '0123',
        filename: 'a.dng',
      }),
    ).toThrow();
  });
});

describe('destRelPathInFolder', () => {
  test('joins an existing (possibly nested) asset folder with the filename', () => {
    expect(destRelPathInFolder({ folderPath: '2024/misc/Trip', filename: 'IMG_0002.dng' })).toBe(
      '2024/misc/Trip/IMG_0002.dng',
    );
  });

  test('throws on an empty folder path', () => {
    expect(() => destRelPathInFolder({ folderPath: '', filename: 'a.dng' })).toThrow();
  });

  test('throws on an unsafe segment or filename', () => {
    expect(() => destRelPathInFolder({ folderPath: '2024/../etc', filename: 'a.dng' })).toThrow();
    expect(() => destRelPathInFolder({ folderPath: '2024/misc', filename: '../a.dng' })).toThrow();
  });
});
