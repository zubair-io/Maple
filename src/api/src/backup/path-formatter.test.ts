import { describe, test, expect } from 'bun:test';
import { formatBackupPath, isSafeFilename, sanitizeLocationSegments } from './path-formatter.ts';

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

  test('no location → year/MM/filename (fallback)', () => {
    expect(
      formatBackupPath({
        captureDate: capture,
        location: null,
        filename: 'IMG_0420.HEIC',
      }),
    ).toBe('2024/03/IMG_0420.HEIC');
  });

  test('empty segment list → year/MM/filename (fallback)', () => {
    expect(formatBackupPath({ captureDate: capture, location: [], filename: 'IMG.heic' })).toBe(
      '2024/03/IMG.heic',
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

  test('all-empty segments fall back to year/MM', () => {
    expect(
      formatBackupPath({ captureDate: capture, location: ['', '  '], filename: 'IMG.heic' }),
    ).toBe('2024/03/IMG.heic');
  });
});

describe('sanitizeLocationSegments', () => {
  test('null → []', () => expect(sanitizeLocationSegments(null)).toEqual([]));
  test('trims and drops empties', () =>
    expect(sanitizeLocationSegments([' A ', '', '  ', 'B'])).toEqual(['A', 'B']));
  test('replaces both slash kinds with underscore', () =>
    expect(sanitizeLocationSegments(['a/b', 'c\\d'])).toEqual(['a_b', 'c_d']));
  test('drops path-traversal tokens (., .., leading dot) per segment', () =>
    expect(sanitizeLocationSegments(['.', '..', '.hidden', 'Keep'])).toEqual(['Keep']));
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
    // After sanitisation the only segment is dropped → empty → date fallback.
    expect(formatBackupPath({ captureDate: capture, location: ['..'], filename: 'IMG.heic' })).toBe(
      '2024/03/IMG.heic',
    );
  });
});
