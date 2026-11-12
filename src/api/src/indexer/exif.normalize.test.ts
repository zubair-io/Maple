import { describe, expect, it } from 'bun:test';
import { normalizeExif } from './exif.ts';

describe('normalizeExif', () => {
  it('formats a fast exposure as a reciprocal and a long one as seconds', () => {
    expect(normalizeExif({ ExposureTime: 0.005 }).shutter).toBe('1/200');
    expect(normalizeExif({ ExposureTime: 0.5 }).shutter).toBe('1/2');
    expect(normalizeExif({ ExposureTime: 2 }).shutter).toBe('2');
    expect(normalizeExif({ ExposureTime: 2.5 }).shutter).toBe('2.5');
    expect(normalizeExif({ ExposureTime: 30 }).shutter).toBe('30');
  });

  it('passes a zero exposure through as text and omits an absent one', () => {
    expect(normalizeExif({ ExposureTime: 0 }).shutter).toBe('0');
    expect(normalizeExif({}).shutter).toBeNull();
  });

  it('dates from DateTimeOriginal, then CreateDate, as UTC wall-clock', () => {
    expect(
      normalizeExif({ DateTimeOriginal: '2024:06:01 12:34:56', CreateDate: '2000:01:01 00:00:00' }),
    ).toMatchObject({
      captured_at: '2024-06-01T12:34:56.000Z',
      captured_year: 2024,
      captured_month: 6,
    });
    expect(normalizeExif({ CreateDate: '2024:06:01 12:34:57' }).captured_at).toBe(
      '2024-06-01T12:34:57.000Z',
    );
  });
});
