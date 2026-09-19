/**
 * Maple's asset identifier: the 24-character hex value every client holds.
 *
 * Every client-visible primary key in Maple is a 24-character lowercase hex
 * string, because `db/assets.transform.ts` emits `doc._id.toHexString()` into
 * the DTOs the HTTP API returns. Apple, Web and Windows clients hold those
 * strings, compare them, and derive cache keys from them — the web trash
 * service even has a `resolveMongoId()` path. That format is a wire contract,
 * and it did not change when the store underneath it did.
 *
 * The shape is MongoDB's, because that is where the library started, but the
 * driver that used to define it is gone (#3785). This module is where the
 * format now lives: one class that parses, mints, compares and renders it, and
 * the string helpers the repositories use on the column side.
 *
 *   bytes 0-3   seconds since the Unix epoch, big-endian
 *   bytes 4-8   a per-process random value, generated once at module load
 *   bytes 9-11  a counter seeded randomly and incremented per id, big-endian
 *
 * Rows that came across in the import keep their original hex verbatim; rows
 * minted since sit beside them in the same layout, so both sort by creation
 * time and neither is distinguishable to a client.
 *
 * The tables store the hex, not the object: `TEXT` columns hold the 24
 * characters and `repos/values.ts` converts at the DTO boundary. Inside a
 * repository you want {@link isObjectIdHex} and {@link newObjectIdHex}; the
 * class exists for the DTOs, which promise an `ObjectId` to their callers.
 */

/** Length of an ObjectId rendered as lowercase hex. */
export const OBJECT_ID_HEX_LENGTH = 24;

const PROCESS_RANDOM = crypto.getRandomValues(new Uint8Array(5));

/** 3-byte counter space — wraps at 2^24, exactly like the driver's. */
const COUNTER_MODULO = 0x1000000;

let counter = Math.floor(Math.random() * COUNTER_MODULO);

function nextCounter(): number {
  counter = (counter + 1) % COUNTER_MODULO;
  return counter;
}

const HEX = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += HEX[byte >> 4] + HEX[byte & 0x0f];
  }
  return out;
}

/**
 * Mints a new identifier in MongoDB's ObjectId hex form.
 *
 * `atMs` exists so the importer and tests can mint an id that sorts to a
 * specific point in time; production callers omit it.
 */
export function newObjectIdHex(atMs: number = Date.now()): string {
  const seconds = Math.floor(atMs / 1000);
  const count = nextCounter();
  const bytes = new Uint8Array(12);
  bytes[0] = (seconds >> 24) & 0xff;
  bytes[1] = (seconds >> 16) & 0xff;
  bytes[2] = (seconds >> 8) & 0xff;
  bytes[3] = seconds & 0xff;
  bytes.set(PROCESS_RANDOM, 4);
  bytes[9] = (count >> 16) & 0xff;
  bytes[10] = (count >> 8) & 0xff;
  bytes[11] = count & 0xff;
  return toHex(bytes);
}

const OBJECT_ID_HEX_RE = /^[0-9a-f]{24}$/;

/**
 * True when `value` is a 24-character lowercase hex string.
 *
 * Deliberately stricter than {@link ObjectId.isValid}, which also accepts
 * uppercase hex and `ObjectId` instances. The database stores one canonical
 * spelling so `=` comparisons and `PRIMARY KEY` lookups cannot miss on case;
 * callers normalise at the edge with {@link normaliseObjectIdHex}.
 */
export function isObjectIdHex(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID_HEX_RE.test(value);
}

/**
 * Lowercases a hex id that arrived from a client, or returns `null` when it is
 * not an ObjectId hex string at all. Route handlers use this in place of
 * `ObjectId.isValid(param) ? new ObjectId(param) : null`.
 */
export function normaliseObjectIdHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lowered = value.toLowerCase();
  return OBJECT_ID_HEX_RE.test(lowered) ? lowered : null;
}

/**
 * The creation timestamp encoded in an ObjectId hex string, as epoch
 * milliseconds. The string-side twin of {@link ObjectId.getTimestamp}.
 */
export function objectIdHexTimestampMs(hex: string): number {
  if (!isObjectIdHex(hex)) throw new Error(`not an ObjectId hex string: ${hex}`);
  return Number.parseInt(hex.slice(0, 8), 16) * 1000;
}

/**
 * An identifier, as the DTOs carry it.
 *
 * Deliberately a thin wrapper over the canonical hex rather than a byte buffer:
 * the database column is TEXT, every wire representation is the hex, and the
 * only reason this is an object at all is that the DTO types — and therefore
 * every route handler and every client-facing shape — were written against one.
 * Holding the string means a parse is a validation and nothing else, and that
 * `toHexString()` on the hot list path is a field read.
 *
 * `toJSON` is what makes `JSON.stringify(dto)` emit the bare hex, which is the
 * client contract; `toString` is what makes template literals and `String(id)`
 * — the library-roots map key, among others — produce the same thing.
 *
 * Equality is by value: two instances parsed from the same hex are `equals`,
 * and never `===`. Code that compares ids with `===` was already wrong under
 * the driver and is still wrong here.
 */
export class ObjectId {
  readonly #hex: string;

  /**
   * Parses a hex string, copies another id, or mints a fresh one when given
   * nothing.
   *
   * Throws on anything that is not a 24-character hex string, matching the
   * driver this replaces: a malformed id from a client is a 400, and the call
   * sites are written around a throw. Route handlers that would rather test
   * than catch use {@link ObjectId.isValid} or {@link normaliseObjectIdHex}
   * first.
   */
  constructor(value?: string | ObjectId) {
    if (value === undefined) {
      this.#hex = newObjectIdHex();
      return;
    }
    if (value instanceof ObjectId) {
      this.#hex = value.#hex;
      return;
    }
    const normalised = normaliseObjectIdHex(value);
    if (normalised === null) {
      throw new TypeError(
        `invalid identifier: expected a 24-character hex string, got ${JSON.stringify(value)}`,
      );
    }
    this.#hex = normalised;
  }

  /** The canonical lowercase hex — the value the column and the wire carry. */
  toHexString(): string {
    return this.#hex;
  }

  /** As {@link toHexString}, so `String(id)` and `` `${id}` `` both give hex. */
  toString(): string {
    return this.#hex;
  }

  /** As {@link toHexString}, so `JSON.stringify` emits a bare hex string. */
  toJSON(): string {
    return this.#hex;
  }

  /** True when `other` names the same identifier, whatever form it arrived in. */
  equals(other: ObjectId | string | null | undefined): boolean {
    if (other === null || other === undefined) return false;
    const hex = other instanceof ObjectId ? other.#hex : normaliseObjectIdHex(other);
    return hex === this.#hex;
  }

  /** The creation time encoded in the first four bytes. */
  getTimestamp(): Date {
    return new Date(objectIdHexTimestampMs(this.#hex));
  }

  /**
   * True when `value` would be accepted by the constructor.
   *
   * Accepts either case, because this is the edge check route handlers run on
   * a path parameter before parsing it; the constructor lowercases.
   */
  static isValid(value: unknown): boolean {
    return value instanceof ObjectId || normaliseObjectIdHex(value) !== null;
  }

  /** Reads better than `new ObjectId(hex)` where the input is known-good. */
  static createFromHexString(hex: string): ObjectId {
    return new ObjectId(hex);
  }
}

/**
 * Parses an id a client sent, or `null` for anything that is not one.
 *
 * The route-handler form: a bad path parameter is a 400, not an exception, so
 * the caller wants a value it can test rather than a throw it has to catch. Use
 * {@link normaliseObjectIdHex} instead where the hex string is what you want —
 * this exists for the call sites that go on to hand an `ObjectId` to a
 * repository.
 *
 * Extracted in the #2897 review round, when four modules each carried an
 * identical local copy.
 */
export function safeObjectId(raw: string): ObjectId | null {
  const hex = normaliseObjectIdHex(raw);
  return hex === null ? null : new ObjectId(hex);
}

/**
 * A document shape plus the identifier it is stored under.
 *
 * Keeps its name from the driver's type of the same shape because ~30 DTO and
 * repository signatures are written in terms of it, and renaming it would have
 * churned every one of them for nothing.
 */
export type WithId<TDoc> = TDoc & { _id: ObjectId };
