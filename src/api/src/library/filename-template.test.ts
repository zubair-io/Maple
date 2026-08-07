/**
 * Unit tests for `filename-template.ts` (#2636) — pure functions, no Mongo,
 * no filesystem. Verifies the ISO→EXIF-wire conversion, stem/ext
 * splitting, and that `renderTemplatedName` reaches the real native
 * `raw-core` engine and surfaces its errors — skip gracefully when the
 * native dylib isn't built locally (matches `tryGetRawFfi`'s own graceful
 * degrade), same as the other native-library-dependent suites in this
 * package.
 */

import { describe, expect, test } from 'bun:test';
import { tryGetRawFfi } from '../ffi/raw_ffi.ts';
import {
  extensionChanged,
  isoToExifWireFormat,
  renderTemplatedName,
  splitStemExt,
} from './filename-template.ts';

const ffiAvailable = tryGetRawFfi() !== null;
const maybeTest = ffiAvailable ? test : test.skip;

describe('isoToExifWireFormat', () => {
  test('converts an ISO 8601 instant to EXIF wire format in UTC', () => {
    expect(isoToExifWireFormat('2024-06-01T12:34:56.000Z')).toBe('2024:06:01 12:34:56');
  });

  test('returns null for a missing value', () => {
    expect(isoToExifWireFormat(null)).toBeNull();
    expect(isoToExifWireFormat(undefined)).toBeNull();
  });

  test('returns null for an unparseable value', () => {
    expect(isoToExifWireFormat('not-a-date')).toBeNull();
  });
});

describe('splitStemExt', () => {
  test('splits a normal filename', () => {
    expect(splitStemExt('IMG_0001.dng')).toEqual({ stem: 'IMG_0001', ext: 'dng' });
  });

  test('an extensionless filename has an empty ext', () => {
    expect(splitStemExt('README')).toEqual({ stem: 'README', ext: '' });
  });

  test('only the LAST dot separates stem from ext', () => {
    expect(splitStemExt('IMG.edit.dng')).toEqual({ stem: 'IMG.edit', ext: 'dng' });
  });
});

describe('extensionChanged', () => {
  test('true when the extension actually changes', () => {
    expect(extensionChanged('a.dng', 'a.jpg')).toBe(true);
  });

  test('false for a same-extension rename', () => {
    expect(extensionChanged('a.dng', 'b.dng')).toBe(false);
  });

  test('false for a case-only extension rewrite', () => {
    expect(extensionChanged('a.JPG', 'a.jpg')).toBe(false);
  });
});

describe('renderTemplatedName (native engine)', () => {
  maybeTest('renders original/n/ext/date tokens', () => {
    const result = renderTemplatedName({
      template: '{date:%Y%m%d}_{original}_{n}.{ext}',
      originalStem: 'IMG_0042',
      ext: 'cr3',
      capturedAtIso: '2023-11-02T08:15:00.000Z',
      sequenceStart: 1,
      index: 7,
      sequencePadWidth: 4,
    });
    expect(result).toEqual({ ok: true, name: '20231102_IMG_0042_0008.cr3' });
  });

  maybeTest('a reserved-device-name template is rejected', () => {
    const result = renderTemplatedName({
      template: 'CON',
      originalStem: 'x',
      ext: 'dng',
      capturedAtIso: null,
      sequenceStart: 0,
      index: 0,
      sequencePadWidth: 0,
    });
    expect(result.ok).toBe(false);
  });

  maybeTest('a missing captured_at falls back to the engine placeholder, not an error', () => {
    const result = renderTemplatedName({
      template: '{date:%Y}.{ext}',
      originalStem: 'x',
      ext: 'dng',
      capturedAtIso: null,
      sequenceStart: 0,
      index: 0,
      sequencePadWidth: 0,
    });
    expect(result).toEqual({ ok: true, name: 'unknown-date.dng' });
  });
});
