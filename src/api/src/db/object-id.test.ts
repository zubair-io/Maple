/**
 * The identifier has one job: be indistinguishable from the ones clients
 * already hold.
 *
 * Every Apple, Web and Windows install in the field is carrying 24-character
 * hex ids minted by the MongoDB driver, comparing them and deriving cache keys
 * from them. The driver is gone; the format it defined is not, so these cases
 * pin the format itself — the layout, the ordering, the spelling and the four
 * ways an id reaches the wire — rather than comparing against an
 * implementation that is no longer installed.
 *
 * The layout is asserted by construction: byte offsets are read back out of the
 * hex, which is what the driver's own `getTimestamp` did and what any future
 * reader of an old id will do.
 */

import { describe, expect, test } from 'bun:test';
import {
  isObjectIdHex,
  newObjectIdHex,
  normaliseObjectIdHex,
  objectIdHexTimestampMs,
  ObjectId,
  OBJECT_ID_HEX_LENGTH,
  safeObjectId,
} from './object-id.ts';

describe('newObjectIdHex', () => {
  test('mints 24 lowercase hex characters', () => {
    const id = newObjectIdHex();
    expect(id).toHaveLength(OBJECT_ID_HEX_LENGTH);
    expect(id).toMatch(/^[0-9a-f]{24}$/);
  });

  test('does not collide across a burst', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) ids.add(newObjectIdHex());
    expect(ids.size).toBe(20_000);
  });

  test('sorts by creation time, like the ids it has to sit beside', () => {
    const older = newObjectIdHex(Date.parse('2020-01-01T00:00:00.000Z'));
    const newer = newObjectIdHex(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(older < newer).toBe(true);
  });

  test('encodes the timestamp in the first four bytes, big-endian', () => {
    const at = Date.parse('2024-06-01T10:00:00.000Z');
    const id = newObjectIdHex(at);
    expect(objectIdHexTimestampMs(id)).toBe(at);
    // The same four bytes any reader of a pre-existing id will decode.
    expect(Number.parseInt(id.slice(0, 8), 16)).toBe(Math.floor(at / 1000));
  });

  test('keeps the per-process bytes stable and moves only the counter', () => {
    // Bytes 4-8 identify the process and bytes 9-11 are a per-id counter. Two
    // ids minted at the same instant differ, and they differ only in the tail.
    const at = Date.parse('2024-06-01T10:00:00.000Z');
    const first = newObjectIdHex(at);
    const second = newObjectIdHex(at);
    expect(first.slice(0, 18)).toBe(second.slice(0, 18));
    expect(first.slice(18)).not.toBe(second.slice(18));
  });
});

describe('isObjectIdHex', () => {
  test('accepts the canonical spelling only', () => {
    const id = newObjectIdHex();
    expect(isObjectIdHex(id)).toBe(true);
    expect(isObjectIdHex(id.toUpperCase())).toBe(false);
    expect(isObjectIdHex('nope')).toBe(false);
    expect(isObjectIdHex(id.slice(1))).toBe(false);
    expect(isObjectIdHex(null)).toBe(false);
    expect(isObjectIdHex(42)).toBe(false);
  });
});

describe('normaliseObjectIdHex', () => {
  test('lowercases what a client sent and rejects what it should not have', () => {
    const id = newObjectIdHex();
    expect(normaliseObjectIdHex(id.toUpperCase())).toBe(id);
    expect(normaliseObjectIdHex(id)).toBe(id);
    expect(normaliseObjectIdHex('not-an-id')).toBeNull();
    expect(normaliseObjectIdHex(undefined)).toBeNull();
  });
});

describe('objectIdHexTimestampMs', () => {
  test('refuses a value that is not an id', () => {
    expect(() => objectIdHexTimestampMs('nope')).toThrow(/not an ObjectId hex string/);
  });
});

describe('ObjectId', () => {
  test('round-trips the hex a client sent', () => {
    const hex = newObjectIdHex();
    expect(new ObjectId(hex).toHexString()).toBe(hex);
  });

  test('mints its own when given nothing', () => {
    expect(isObjectIdHex(new ObjectId().toHexString())).toBe(true);
  });

  test('copies another id rather than re-parsing it', () => {
    const original = new ObjectId();
    expect(new ObjectId(original).toHexString()).toBe(original.toHexString());
  });

  test('lowercases what a client sent, so the column lookup cannot miss on case', () => {
    // Every id is stored as lowercase hex and looked up with `=`. An uppercase
    // id from a client has to arrive at the query in the stored spelling or it
    // silently finds nothing.
    const hex = newObjectIdHex();
    expect(new ObjectId(hex.toUpperCase()).toHexString()).toBe(hex);
  });

  test('refuses anything that is not an id', () => {
    expect(() => new ObjectId('nope')).toThrow(/invalid identifier/);
    expect(() => new ObjectId(newObjectIdHex().slice(1))).toThrow(/invalid identifier/);
  });

  test('reaches the wire as a bare hex string, however it is rendered', () => {
    // The client contract, in the four shapes it actually travels in: a DTO
    // serialised to JSON, a template literal, `String(id)` (the library-roots
    // map key), and an explicit `toHexString()`.
    const hex = newObjectIdHex();
    const id = new ObjectId(hex);
    expect(JSON.stringify({ _id: id })).toBe(`{"_id":"${hex}"}`);
    expect(`${id}`).toBe(hex);
    expect(String(id)).toBe(hex);
    expect(id.toHexString()).toBe(hex);
  });

  test('compares by value, never by reference', () => {
    const hex = newObjectIdHex();
    const a = new ObjectId(hex);
    const b = new ObjectId(hex);
    expect(a === b).toBe(false);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(hex)).toBe(true);
    expect(a.equals(hex.toUpperCase())).toBe(true);
    expect(a.equals(new ObjectId())).toBe(false);
    expect(a.equals(null)).toBe(false);
    expect(a.equals(undefined)).toBe(false);
  });

  test('reads its own creation time back', () => {
    const at = Date.parse('2024-06-01T10:00:00.000Z');
    expect(new ObjectId(newObjectIdHex(at)).getTimestamp().getTime()).toBe(at);
  });

  test('isValid answers for the edge check a route handler runs', () => {
    const hex = newObjectIdHex();
    expect(ObjectId.isValid(hex)).toBe(true);
    expect(ObjectId.isValid(hex.toUpperCase())).toBe(true);
    expect(ObjectId.isValid(new ObjectId(hex))).toBe(true);
    expect(ObjectId.isValid('nope')).toBe(false);
    expect(ObjectId.isValid(undefined)).toBe(false);
    expect(ObjectId.isValid(42)).toBe(false);
  });

  test('createFromHexString is the constructor', () => {
    const hex = newObjectIdHex();
    expect(ObjectId.createFromHexString(hex).toHexString()).toBe(hex);
  });
});

describe('safeObjectId', () => {
  test('answers null instead of throwing, so a bad path parameter is a 400', () => {
    const hex = newObjectIdHex();
    expect(safeObjectId(hex)?.toHexString()).toBe(hex);
    expect(safeObjectId(hex.toUpperCase())?.toHexString()).toBe(hex);
    expect(safeObjectId('nope')).toBeNull();
    expect(safeObjectId('')).toBeNull();
  });
});
