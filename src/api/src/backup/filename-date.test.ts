/**
 * Unit tests for `parseFilenameCapturedAt` — the Android default-camera
 * filename fallback (`IMG_YYYYMMDD_HHMMSS[_NNN].<ext>`) used when a legacy
 * backup-format asset has no EXIF capture time.
 */
import { describe, test, expect } from 'bun:test';
import { parseFilenameCapturedAt } from './filename-date.ts';

describe('parseFilenameCapturedAt', () => {
  test('parses the Android IMG_YYYYMMDD_HHMMSS_NNN convention as UTC', () => {
    const d = parseFilenameCapturedAt('IMG_20170930_121056_345.jpg');
    expect(d).not.toBeNull();
    expect(d?.toISOString()).toBe('2017-09-30T12:10:56.000Z');
  });

  test('parses without the trailing _NNN sequence number', () => {
    const d = parseFilenameCapturedAt('IMG_20170930_121056.jpg');
    expect(d?.toISOString()).toBe('2017-09-30T12:10:56.000Z');
  });

  test('is case-insensitive on the prefix and extension', () => {
    const d = parseFilenameCapturedAt('img_20170930_121056.JPG');
    expect(d?.toISOString()).toBe('2017-09-30T12:10:56.000Z');
  });

  test('returns null for a filename that does not match the convention', () => {
    expect(parseFilenameCapturedAt('DSC_0001.jpg')).toBeNull();
  });

  test('returns null for an impossible calendar date (Feb 30)', () => {
    expect(parseFilenameCapturedAt('IMG_20170230_121056.jpg')).toBeNull();
  });

  test('returns null for an out-of-range month', () => {
    expect(parseFilenameCapturedAt('IMG_20171330_121056.jpg')).toBeNull();
  });

  test('returns null for an out-of-range time component', () => {
    expect(parseFilenameCapturedAt('IMG_20170930_256056.jpg')).toBeNull();
  });

  test('returns null for an implausible year', () => {
    expect(parseFilenameCapturedAt('IMG_00000000_000000.jpg')).toBeNull();
  });
});
