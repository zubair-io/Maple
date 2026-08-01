/**
 * Unit tests for the seek-cursor codec + predicate builder (#2129).
 *
 * These are pure — no Mongo. The end-to-end paging behaviour (including
 * the null/missing `captured_at` group, which is the part MongoDB's type
 * bracketing makes easy to get wrong) is covered against a real database
 * in `cursor-paging.test.ts`.
 */

import { describe, expect, it } from 'bun:test';
import { ObjectId } from 'mongodb';
import {
  cursorDirectionFor,
  cursorFromDoc,
  decodeCursor,
  encodeCursor,
  seekFilter,
  type SeekCursor,
} from './cursor.ts';

const ID_A = '0123456789abcdef01234567';

describe('cursorDirectionFor', () => {
  it('maps the two captured_at sorts to their direction', () => {
    expect(cursorDirectionFor('captured_desc')).toBe('desc');
    expect(cursorDirectionFor('captured_asc')).toBe('asc');
  });

  it('refuses the sorts that have no correct seek', () => {
    // `name` sorts on a multikey path; `rating` is a 3-key tuple with no
    // backing compound index. Both stay on skip pagination — see cursor.ts.
    expect(cursorDirectionFor('name')).toBeNull();
    expect(cursorDirectionFor('rating')).toBeNull();
    expect(cursorDirectionFor('')).toBeNull();
    expect(cursorDirectionFor('captured_desc ')).toBeNull();
  });
});

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a string-valued cursor', () => {
    const c: SeekCursor = { v: '2024-03-01T10:00:00.000Z', i: ID_A, d: 'desc' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('round-trips a null-valued (untimed group) cursor', () => {
    const c: SeekCursor = { v: null, i: ID_A, d: 'asc' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('emits base64url — no +, / or = to break a query string', () => {
    const encoded = encodeCursor({ v: '2024-03-01T10:00:00.000Z', i: ID_A, d: 'desc' });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });

  it('is opaque — the caller sees no field names', () => {
    const encoded = encodeCursor({ v: '2024-03-01T10:00:00.000Z', i: ID_A, d: 'desc' });
    expect(encoded).not.toContain('captured');
    expect(encoded).not.toContain(ID_A);
  });
});

describe('decodeCursor rejects forged input', () => {
  const encodeRaw = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

  it('rejects an operator document in the value position', () => {
    // The whole point of forcing `v` to a primitive: MongoDB only treats
    // *objects* as operator documents, so a `{$ne: null}` payload must never
    // survive decoding into the query.
    expect(decodeCursor(encodeRaw({ v: { $ne: null }, i: ID_A, d: 'desc' }))).toBeNull();
    expect(decodeCursor(encodeRaw({ v: { $gt: '' }, i: ID_A, d: 'desc' }))).toBeNull();
    expect(decodeCursor(encodeRaw({ v: ['a'], i: ID_A, d: 'desc' }))).toBeNull();
    expect(decodeCursor(encodeRaw({ v: 5, i: ID_A, d: 'desc' }))).toBeNull();
  });

  it('rejects an operator document in the _id position', () => {
    expect(decodeCursor(encodeRaw({ v: null, i: { $ne: null }, d: 'desc' }))).toBeNull();
    expect(decodeCursor(encodeRaw({ v: null, i: 'not-a-hex-objectid', d: 'desc' }))).toBeNull();
    expect(decodeCursor(encodeRaw({ v: null, i: ID_A.toUpperCase(), d: 'desc' }))).toBeNull();
    expect(decodeCursor(encodeRaw({ v: null, i: ID_A + 'ab', d: 'desc' }))).toBeNull();
  });

  it('rejects a bad or missing direction', () => {
    expect(decodeCursor(encodeRaw({ v: null, i: ID_A, d: 'sideways' }))).toBeNull();
    expect(decodeCursor(encodeRaw({ v: null, i: ID_A }))).toBeNull();
  });

  it('rejects non-object payloads and garbage', () => {
    expect(decodeCursor(encodeRaw([1, 2, 3]))).toBeNull();
    expect(decodeCursor(encodeRaw('plain string'))).toBeNull();
    expect(decodeCursor(encodeRaw(null))).toBeNull();
    expect(decodeCursor('not base64 !!!')).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('rejects oversized cursors before doing any parsing work', () => {
    expect(decodeCursor('A'.repeat(513))).toBeNull();
    expect(decodeCursor(encodeRaw({ v: 'x'.repeat(65), i: ID_A, d: 'desc' }))).toBeNull();
  });
});

describe('cursorFromDoc', () => {
  const oid = new ObjectId(ID_A);

  it('reads a string captured_at through', () => {
    expect(cursorFromDoc({ _id: oid, exif: { captured_at: '2024-01-01' } }, 'desc')).toEqual({
      v: '2024-01-01',
      i: ID_A,
      d: 'desc',
    });
  });

  it('normalises every untimed shape to null', () => {
    const expected: SeekCursor = { v: null, i: ID_A, d: 'asc' };
    expect(cursorFromDoc({ _id: oid, exif: { captured_at: null } }, 'asc')).toEqual(expected);
    expect(cursorFromDoc({ _id: oid, exif: {} }, 'asc')).toEqual(expected);
    expect(cursorFromDoc({ _id: oid }, 'asc')).toEqual(expected);
    expect(cursorFromDoc({ _id: oid, exif: null }, 'asc')).toEqual(expected);
  });
});

describe('seekFilter', () => {
  const oid = new ObjectId(ID_A);

  it('desc from a timed row spans the boundary into the untimed tail', () => {
    // The untimed group sorts *after* every string descending, so it has to
    // ride along in the same `$or`; Mongo's sort+limit only reaches it once
    // the strings are exhausted.
    expect(seekFilter({ v: '2024-01-01', i: ID_A, d: 'desc' })).toEqual({
      $or: [
        { 'exif.captured_at': { $lt: '2024-01-01' } },
        { 'exif.captured_at': '2024-01-01', _id: { $gt: oid } },
        { 'exif.captured_at': null },
      ],
    });
  });

  it('desc from an untimed row stays inside the untimed tail', () => {
    expect(seekFilter({ v: null, i: ID_A, d: 'desc' })).toEqual({
      'exif.captured_at': null,
      _id: { $gt: oid },
    });
  });

  it('asc from an untimed row spans the boundary into the timed rows', () => {
    expect(seekFilter({ v: null, i: ID_A, d: 'asc' })).toEqual({
      $or: [
        { 'exif.captured_at': null, _id: { $gt: oid } },
        { 'exif.captured_at': { $type: 'string' } },
      ],
    });
  });

  it('asc from a timed row does not re-emit the already-consumed untimed head', () => {
    expect(seekFilter({ v: '2024-01-01', i: ID_A, d: 'asc' })).toEqual({
      $or: [
        { 'exif.captured_at': { $gt: '2024-01-01' } },
        { 'exif.captured_at': '2024-01-01', _id: { $gt: oid } },
      ],
    });
  });
});
