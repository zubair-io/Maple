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

  test('parses the OneDrive YYYYMMDD_HHMMSSmmm_iOS convention as UTC with milliseconds', () => {
    const d = parseFilenameCapturedAt('20101011_035847220_iOS.jpg');
    expect(d).not.toBeNull();
    expect(d?.toISOString()).toBe('2010-10-11T03:58:47.220Z');
  });

  test('is case-insensitive on the OneDrive _iOS suffix and extension', () => {
    const d = parseFilenameCapturedAt('20101011_035847220_ios.HEIC');
    expect(d?.toISOString()).toBe('2010-10-11T03:58:47.220Z');
  });

  test('returns null for the OneDrive shape without the _iOS suffix', () => {
    expect(parseFilenameCapturedAt('20101011_035847220.jpg')).toBeNull();
  });

  test('returns null for a OneDrive-shaped name with an impossible calendar date', () => {
    expect(parseFilenameCapturedAt('20100230_035847220_iOS.jpg')).toBeNull();
  });

  test('returns null for a OneDrive-shaped name with an out-of-range time', () => {
    expect(parseFilenameCapturedAt('20101011_255847220_iOS.jpg')).toBeNull();
  });

  test('returns null for a OneDrive-shaped name with an implausible year', () => {
    expect(parseFilenameCapturedAt('00000000_000000000_iOS.jpg')).toBeNull();
  });
});
