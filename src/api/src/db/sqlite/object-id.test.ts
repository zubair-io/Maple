/**
 * The identifier generator has one job: mint values a MongoDB-era client
 * cannot tell apart from the ones it already holds. The driver is still a
 * dependency during the migration, so `ObjectId` itself is the oracle.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import {
  isObjectIdHex,
  newObjectIdHex,
  normaliseObjectIdHex,
  objectIdHexTimestampMs,
  OBJECT_ID_HEX_LENGTH,
} from './object-id.ts';

describe('newObjectIdHex', () => {
  test('mints 24 lowercase hex characters', () => {
    const id = newObjectIdHex();
    expect(id).toHaveLength(OBJECT_ID_HEX_LENGTH);
    expect(id).toMatch(/^[0-9a-f]{24}$/);
  });

  test('is accepted by the MongoDB driver and round-trips through it', () => {
    const id = newObjectIdHex();
    expect(ObjectId.isValid(id)).toBe(true);
    expect(new ObjectId(id).toHexString()).toBe(id);
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

  test('encodes the timestamp where the driver reads it', () => {
    const at = Date.parse('2024-06-01T10:00:00.000Z');
    const id = newObjectIdHex(at);
    expect(objectIdHexTimestampMs(id)).toBe(at);
    expect(new ObjectId(id).getTimestamp().getTime()).toBe(at);
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
