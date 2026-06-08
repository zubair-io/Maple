import { describe, test, expect } from 'bun:test';
import { ObjectId } from 'mongodb';
import {
  computeScreenshotDir,
  DATED_BACKUP_DIR_RE,
  SCREENSHOT_DIR_RE,
} from './restructure-screenshot-path.ts';
import type { FileInfo } from '../../db/schema.ts';

function fi(p: string): FileInfo {
  return { path: p, filename: 'Screenshot.png', library_id: new ObjectId(), deleted_at: null };
}

describe('computeScreenshotDir', () => {
  test('relocates a date-folder screenshot to year/Screenshot', () => {
    expect(computeScreenshotDir({ fileinfo: [fi('2024/03')] })).toBe('2024/Screenshot');
  });

  test('relocates a location-folder screenshot to year/Screenshot', () => {
    expect(computeScreenshotDir({ fileinfo: [fi('2024/California/San Francisco')] })).toBe(
      '2024/Screenshot',
    );
  });

  test('relocates an old MM-DD day-folder screenshot straight to year/Screenshot', () => {
    // Reads only the leading year, so it skips the intermediate flatten.
    expect(computeScreenshotDir({ fileinfo: [fi('2019/05/12')] })).toBe('2019/Screenshot');
  });

  test('keeps the year the file already lives under (no cross-year move)', () => {
    expect(computeScreenshotDir({ fileinfo: [fi('2019/08')], exif: { captured_year: 2024 } })).toBe(
      '2019/Screenshot',
    );
  });

  test('already in year/Screenshot → returns current dir (no-op move)', () => {
    expect(computeScreenshotDir({ fileinfo: [fi('2024/Screenshot')] })).toBe('2024/Screenshot');
  });

  test('falls back to EXIF year when the path has no 4-digit lead', () => {
    expect(
      computeScreenshotDir({ fileinfo: [fi('weird/loc')], exif: { captured_year: 2021 } }),
    ).toBe('2021/Screenshot');
  });

  test('no determinable year → null', () => {
    expect(computeScreenshotDir({ fileinfo: [fi('weird')] })).toBeNull();
  });

  test('missing fileinfo → null', () => {
    expect(computeScreenshotDir({})).toBeNull();
  });
});

describe('SCREENSHOT_DIR_RE / DATED_BACKUP_DIR_RE', () => {
  test('SCREENSHOT_DIR_RE matches only year/Screenshot exactly', () => {
    expect(SCREENSHOT_DIR_RE.test('2024/Screenshot')).toBe(true);
    expect(SCREENSHOT_DIR_RE.test('2024/03')).toBe(false);
    // Not a prefix match — a deeper or differently-cased path is not "filed".
    expect(SCREENSHOT_DIR_RE.test('2024/Screenshot/sub')).toBe(false);
    expect(SCREENSHOT_DIR_RE.test('2024/Screenshots')).toBe(false);
    expect(SCREENSHOT_DIR_RE.test('California/Screenshot')).toBe(false);
  });

  // The query ANDs DATED_BACKUP_DIR_RE with a `$nor` on SCREENSHOT_DIR_RE; this
  // pins the behaviour of each half independently.
  test('DATED_BACKUP_DIR_RE matches any <year>/… path', () => {
    expect(DATED_BACKUP_DIR_RE.test('2024/03')).toBe(true);
    expect(DATED_BACKUP_DIR_RE.test('2024/California/San Francisco')).toBe(true);
    expect(DATED_BACKUP_DIR_RE.test('2019/05/12')).toBe(true);
    expect(DATED_BACKUP_DIR_RE.test('2024/Screenshot')).toBe(true); // dated; $nor excludes it
    expect(DATED_BACKUP_DIR_RE.test('weird/loc')).toBe(false);
  });
});
