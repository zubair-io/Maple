/**
 * ObjectId-shaped identifier generator for the SQLite backend.
 *
 * Every client-visible primary key in Maple is a 24-character lowercase hex
 * string today, because `db/assets.transform.ts` emits `doc._id.toHexString()`
 * into the DTOs the HTTP API returns. Apple, Web and Windows clients hold
 * those strings, compare them, and derive cache keys from them — the web trash
 * service even has a `resolveMongoId()` path. The SQLite migration's stated
 * non-goal is that clients change at all, so the identifiers have to survive
 * the engine swap byte-for-byte. That rules out `INTEGER PRIMARY KEY` rowid
 * aliases for any table whose id reaches a client.
 *
 * Rows imported from MongoDB keep their existing `_id` hex verbatim. Rows
 * created after the migration need an identifier of the same shape, which is
 * what this module mints: the same 12-byte layout MongoDB uses, so the values
 * stay sortable by creation time and `ObjectId.isValid()` keeps accepting them
 * for as long as any mixed-mode code path exists.
 *
 *   bytes 0-3   seconds since the Unix epoch, big-endian
 *   bytes 4-8   a per-process random value, generated once at module load
 *   bytes 9-11  a counter seeded randomly and incremented per id, big-endian
 *
 * No dependency on the `mongodb` driver: the point of the migration is to be
 * able to drop it.
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
 * Deliberately stricter than `ObjectId.isValid`, which also accepts uppercase
 * hex, 12-byte binary strings and `ObjectId` instances. The database stores one
 * canonical spelling so `=` comparisons and `PRIMARY KEY` lookups cannot miss
 * on case; callers normalise at the edge with {@link normaliseObjectIdHex}.
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
 * milliseconds. Mirrors `ObjectId.getTimestamp()`; used by the importer to
 * sanity-check that imported ids carry plausible dates.
 */
export function objectIdHexTimestampMs(hex: string): number {
  if (!isObjectIdHex(hex)) throw new Error(`not an ObjectId hex string: ${hex}`);
  return Number.parseInt(hex.slice(0, 8), 16) * 1000;
}
