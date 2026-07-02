import { describe, test, expect } from 'bun:test';
import {
  formatBackupPath,
  isSafeFilename,
  sanitizeLocationSegments,
  SCREENSHOT_DIR_SEGMENT,
} from './path-formatter.ts';

const capture = new Date('2024-03-15T10:30:00Z');

describe('formatBackupPath', () => {
  test('USA → year/State/City/filename', () => {
    expect(
      formatBackupPath({
        captureDate: capture,
        location: ['California', 'San Francisco'],
        filename: 'IMG_0420.HEIC',
      }),
    ).toBe('2024/California/San Francisco/IMG_0420.HEIC');
  });

  test('non-USA → year/Country/City/filename', () => {
    expect(
      formatBackupPath({
        captureDate: capture,
        location: ['France', 'Paris'],
        filename: 'IMG_0420.HEIC',
      }),
    ).toBe('2024/France/Paris/IMG_0420.HEIC');
  });

  test('single segment (region but no locality) → year/Region/filename', () => {
    expect(
      formatBackupPath({
        captureDate: capture,
        location: ['Nevada'],
        filename: 'IMG.heic',
      }),
    ).toBe('2024/Nevada/IMG.heic');
  });

  test('no location → year/Misc/filename (fallback)', () => {
    expect(
      formatBackupPath({
        captureDate: capture,
        location: null,
        filename: 'IMG_0420.HEIC',
      }),
    ).toBe('2024/Misc/IMG_0420.HEIC');
  });

  test('empty segment list → year/Misc/filename (fallback)', () => {
    expect(formatBackupPath({ captureDate: capture, location: [], filename: 'IMG.heic' })).toBe(
      '2024/Misc/IMG.heic',
    );
  });

  test('escapes slashes within a segment (stays one directory level)', () => {
    expect(
      formatBackupPath({
        captureDate: capture,
        location: ['St. Tropez / Var', 'Saint-Tropez'],
        filename: 'IMG.heic',
      }),
    ).toBe('2024/St. Tropez _ Var/Saint-Tropez/IMG.heic');
  });

  test('drops empty / whitespace segments but keeps the rest', () => {
    expect(
      formatBackupPath({
        captureDate: capture,
        location: ['Japan', '   ', 'Kyoto'],
        filename: 'IMG.heic',
      }),
    ).toBe('2024/Japan/Kyoto/IMG.heic');
  });

  test('all-empty segments fall back to year/Misc', () => {
    expect(
      formatBackupPath({ captureDate: capture, location: ['', '  '], filename: 'IMG.heic' }),
    ).toBe('2024/Misc/IMG.heic');
  });

  test('screenshot → year/Screenshot/filename', () => {
    expect(
      formatBackupPath({
        captureDate: capture,
        location: null,
        filename: 'Screenshot.png',
        isScreenshot: true,
      }),
    ).toBe('2024/Screenshot/Screenshot.png');
  });

  test('screenshot wins over a GPS location', () => {
    // A screenshot with stray GPS still goes to <year>/Screenshot, not the
    // location layout.
    expect(
      formatBackupPath({
        captureDate: capture,
        location: ['California', 'San Francisco'],
        filename: 'Screenshot.png',
        isScreenshot: true,
      }),
    ).toBe(`2024/${SCREENSHOT_DIR_SEGMENT}/Screenshot.png`);
  });

  test('isScreenshot:false behaves exactly like the date/location layout', () => {
    expect(
      formatBackupPath({
        captureDate: capture,
        location: null,
        filename: 'IMG.heic',
        isScreenshot: false,
      }),
    ).toBe('2024/Misc/IMG.heic');
  });

  test('screenshot still rejects an unsafe filename', () => {
    expect(() =>
      formatBackupPath({
        captureDate: capture,
        location: null,
        filename: '../etc/passwd',
        isScreenshot: true,
      }),
    ).toThrow('unsafe filename');
  });
});

describe('sanitizeLocationSegments', () => {
  test('null/undefined → []', () => {
    expect(sanitizeLocationSegments(null)).toEqual([]);
    expect(sanitizeLocationSegments(undefined)).toEqual([]);
  });
  test('trims and drops empties', () =>
    expect(sanitizeLocationSegments([' A ', '', '  ', 'B'])).toEqual(['A', 'B']));
  test('trims newlines/CR/tabs (JS trim() semantics — Swift parity)', () =>
    expect(sanitizeLocationSegments(['Paris\n', '\tKyoto', 'Var\r\n'])).toEqual([
      'Paris',
      'Kyoto',
      'Var',
    ]));
  test('replaces both slash kinds with underscore', () =>
    expect(sanitizeLocationSegments(['a/b', 'c\\d'])).toEqual(['a_b', 'c_d']));
  test('drops path-traversal tokens (., .., leading dot) per segment', () =>
    expect(sanitizeLocationSegments(['.', '..', '.hidden', '...dotty', 'Keep'])).toEqual(['Keep']));
  test('drops null/undefined elements in the array', () =>
    // @ts-expect-error testing invalid input types
    expect(sanitizeLocationSegments(['A', null, 'B', undefined, 'C'])).toEqual(['A', 'B', 'C']));
  test('mixed valid and invalid segments', () =>
    expect(
      sanitizeLocationSegments([
        '  California  ',
        '.',
        'San Francisco',
        '..',
        'Hidden/Folder',
        '.hidden',
        '',
      ]),
    ).toEqual(['California', 'San Francisco', 'Hidden_Folder']));
});

describe('isSafeFilename', () => {
  test('empty string → false', () => expect(isSafeFilename('')).toBe(false));
  test('name over 255 chars → false', () => expect(isSafeFilename('a'.repeat(256))).toBe(false));
  test('name with forward slash → false', () => expect(isSafeFilename('foo/bar.jpg')).toBe(false));
  test('name with backslash → false', () => expect(isSafeFilename('foo\\bar.jpg')).toBe(false));
  test("'.' → false", () => expect(isSafeFilename('.')).toBe(false));
  test("'..' → false", () => expect(isSafeFilename('..')).toBe(false));
  test('leading dot → false', () => expect(isSafeFilename('.hidden')).toBe(false));
  test('normal filename → true', () => expect(isSafeFilename('IMG_0420.HEIC')).toBe(true));
  test('exactly 255 chars → true', () => expect(isSafeFilename('a'.repeat(255))).toBe(true));
});

describe('formatBackupPath — filename safety', () => {
  test("'../etc/passwd' filename → throws", () => {
    expect(() =>
      formatBackupPath({ captureDate: capture, location: null, filename: '../etc/passwd' }),
    ).toThrow('unsafe filename');
  });

  test("'foo/bar.jpg' filename → throws", () => {
    expect(() =>
      formatBackupPath({ captureDate: capture, location: null, filename: 'foo/bar.jpg' }),
    ).toThrow('unsafe filename');
  });

  test("'.hidden' filename → throws", () => {
    expect(() =>
      formatBackupPath({ captureDate: capture, location: null, filename: '.hidden' }),
    ).toThrow('unsafe filename');
  });

  test('empty filename → throws', () => {
    expect(() => formatBackupPath({ captureDate: capture, location: null, filename: '' })).toThrow(
      'unsafe filename',
    );
  });

  test('256-char filename → throws', () => {
    expect(() =>
      formatBackupPath({ captureDate: capture, location: null, filename: 'a'.repeat(256) }),
    ).toThrow('unsafe filename');
  });

  test("'..'-only location segment → fallback to no-GPS shape", () => {
    // After sanitisation the only segment is dropped → empty → Misc fallback.
    expect(formatBackupPath({ captureDate: capture, location: ['..'], filename: 'IMG.heic' })).toBe(
      '2024/Misc/IMG.heic',
    );
  });
});
