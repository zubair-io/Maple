import { describe, expect, test } from 'bun:test';
import { mimeForExt, parseByteRange } from './shared.ts';

describe('parseByteRange', () => {
  test('parses bounded, open-ended, and suffix ranges', () => {
    expect(parseByteRange('bytes=2-5', 10)).toEqual({
      ok: true,
      start: 2,
      end: 5,
    });
    expect(parseByteRange('bytes=5-', 10)).toEqual({
      ok: true,
      start: 5,
      end: 9,
    });
    expect(parseByteRange('bytes=-4', 10)).toEqual({
      ok: true,
      start: 6,
      end: 9,
    });
  });

  test('clamps the end and rejects unsatisfiable ranges', () => {
    expect(parseByteRange('bytes=8-99', 10)).toEqual({
      ok: true,
      start: 8,
      end: 9,
    });
    expect(parseByteRange('bytes=10-', 10)).toEqual({ ok: false });
    expect(parseByteRange('bytes=8-4', 10)).toEqual({ ok: false });
    expect(parseByteRange('bytes=0-1,4-5', 10)).toEqual({ ok: false });
  });
});

describe('video MIME types', () => {
  test('covers every supported video container family', () => {
    expect(mimeForExt('MOV')).toBe('video/quicktime');
    expect(mimeForExt('m2ts')).toBe('video/mp2t');
    expect(mimeForExt('3gp')).toBe('video/3gpp');
    expect(mimeForExt('mxf')).toBe('application/mxf');
    expect(mimeForExt('wmv')).toBe('video/x-ms-wmv');
  });
});
