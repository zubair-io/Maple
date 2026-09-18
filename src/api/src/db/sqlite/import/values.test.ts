/**
 * BSON values a JSON column can hold, and the ones that have to be refused
 * instead of rewritten (#3744).
 *
 * The rewrite is the dangerous half. A wrapper `normaliseJson` does not
 * recognise used to fall through to the plain-object walk and be stored as the
 * driver's internal representation — valid JSON, `json_valid` happy, the
 * generated columns extracting something, and the value gone. Verification
 * could not catch it either, because it compares the source through this same
 * function and so agrees with itself about the wrong answer. Refusing is what
 * turns it into a reject with the document's id on it.
 *
 * These need no database of any kind.
 */

import { describe, expect, it } from 'bun:test';
import { Binary, Decimal128, Long, ObjectId } from 'mongodb';
import { normaliseJson, toJsonText } from './values.ts';

describe('normaliseJson', () => {
  it('renders the three types the schema depends on', () => {
    const id = new ObjectId();
    expect(normaliseJson(id)).toBe(id.toHexString());
    expect(normaliseJson(new Date(Date.UTC(2026, 0, 2)))).toBe('2026-01-02T00:00:00.000Z');
    expect(normaliseJson(new Binary(Uint8Array.from([1, 2, 3])))).toBe('AQID');
  });

  it('converts them wherever they are nested', () => {
    const id = new ObjectId();
    expect(normaliseJson({ a: [{ b: id }] })).toEqual({ a: [{ b: id.toHexString() }] });
  });

  it('keeps the numbers the driver hands back as JavaScript numbers', () => {
    // `Int32` and `Double` reach the importer already promoted, which is why
    // there is no wrapper handling for them and why an unpromoted one would
    // be refused like any other undecided type.
    expect(normaliseJson({ n: 7, f: 1.5 })).toEqual({ n: 7, f: 1.5 });
  });

  it('refuses a BSON wrapper it has no text form for, naming the type', () => {
    expect(() => normaliseJson(Decimal128.fromString('1.25'))).toThrow('Decimal128');
    expect(() => normaliseJson(Long.fromNumber(2))).toThrow('Long');
    expect(() => toJsonText({ exif: { shutter: Decimal128.fromString('0.004') } })).toThrow(
      'unsupported BSON type Decimal128',
    );
  });

  it('refuses a plain JavaScript value with no JSON form either', () => {
    // A RegExp stringifies to `{}`, which is the same silent loss in a
    // different costume — the driver hands one back for a stored pattern
    // unless it is asked for the BSON wrapper.
    expect(() => normaliseJson(/^a/u)).toThrow('RegExp');
    expect(() => normaliseJson(new Map([['a', 1]]))).toThrow('Map');
  });

  it('renders raw bytes as base64 rather than as an object of indexes', () => {
    expect(normaliseJson(Uint8Array.from([1, 2, 3]))).toBe('AQID');
  });
});
