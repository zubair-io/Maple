/**
 * Seek (range) pagination for `GET /api/search` — #2129.
 *
 * `skip = page * limit` makes MongoDB walk and discard every skipped index
 * entry, so cost grows linearly with page depth. This module replaces the
 * skip with a compound range predicate on `(exif.captured_at, _id)` — the
 * exact tuple the default sort already orders by, and the reason the `_id`
 * tiebreak exists (see `sort.ts`). With the `#2128` compound index
 * (`fileinfo.library_id: 1, exif.captured_at: -1, _id: 1`) the seek is a
 * single index re-position, so page 500 costs what page 0 does.
 *
 * ## Which sorts get a cursor
 *
 * Only `captured_desc` / `captured_asc`. The other two are deliberately
 * left on skip pagination, and the route says so on the wire by returning
 * `nextCursor: null`:
 *
 *   - `name` sorts on `fileinfo.filename`, a **multikey** path. A range
 *     predicate on a multikey field matches when ANY array element
 *     satisfies it, while the sort compares by the array's smallest
 *     element — the two disagree, so a seek would silently drop or repeat
 *     rows on assets deduped across locations.
 *   - `rating` sorts on a three-key tuple with no backing compound index,
 *     so a seek buys nothing over the skip it would replace.
 *   - The `placeQuery` text path sorts by `$meta: 'textScore'` first, which
 *     is not a stored field and therefore not seekable at all.
 *
 * ## Type bracketing
 *
 * MongoDB range predicates are type-bracketed: `{ca: {$lt: "2024-…"}}`
 * only ever matches **string** values of `ca`. `AssetDoc`'s `exif`
 * declares `captured_at: string | null` and the `exif` stage writes an
 * ISO-8601 string, so exactly two BSON type classes reach this field —
 * String, and Null (explicit `null`, a missing `captured_at`, or a missing
 * `exif` sub-document, all of which Mongo treats identically for equality
 * to `null`). In the BSON sort order Null sorts below String, so those rows
 * form a contiguous group: the *tail* under `captured_desc`, the *head*
 * under `captured_asc`. A naive `$lt` seek walks off the end of the string
 * range and drops that entire group.
 *
 * The cursor therefore records which of the two groups the last row came
 * from (`v: string` vs `v: null`) and `seekFilter` emits a predicate that
 * spans the boundary exactly once:
 *
 *   - desc, `v` is a string → strings below `v`, the `_id` tiebreak at
 *     `v`, **plus** the whole nullish group (which sorts after every
 *     string, so Mongo's `limit` only reaches it once the strings run out
 *     — no duplication, because the next cursor is then a nullish one).
 *   - desc, `v` is null → the nullish group with `_id` past the cursor.
 *   - asc, `v` is null → the nullish group past the cursor, **plus** every
 *     string (which sorts after nulls ascending).
 *   - asc, `v` is a string → strings above `v` plus the `_id` tiebreak.
 *
 * `{'exif.captured_at': null}` matches both explicit-null and missing and
 * has tight `[null, null]` index bounds on the (non-sparse) compound
 * index, so the boundary-spanning branch stays a cheap seek rather than a
 * scan. `{$type: 'string'}` is likewise a single contiguous index range.
 *
 * ## Opacity + injection
 *
 * The cursor is base64url-encoded JSON, opaque to clients but never
 * trusted: `decodeCursor` rejects anything that isn't `{v: string|null,
 * i: <24 hex>, d: 'asc'|'desc'}`. Requiring `v` to be a primitive string
 * is what makes a forged cursor un-injectable — MongoDB only interprets
 * *objects* in the value position as operator documents, so a `{$ne: null}`
 * or `{$where: …}` payload can never reach the query.
 */

import { ObjectId } from 'mongodb';
import type { Filter } from 'mongodb';
import type { AssetDoc } from '../../db/schema.ts';

const CAPTURED_AT = 'exif.captured_at';

/** Direction of the `(captured_at, _id)` seek. */
export type CursorDirection = 'asc' | 'desc';

/** Decoded seek position: the sort key of the last row of the previous page. */
export interface SeekCursor {
  /** `exif.captured_at` of the last row, or `null` when that row is in the
   * missing/null group (see the type-bracketing note above). */
  v: string | null;
  /** `_id` of the last row, as a 24-char hex string. */
  i: string;
  /** Direction the cursor was minted under. A cursor is only valid for a
   * request whose sort resolves to the same direction. */
  d: CursorDirection;
}

/** Sort tokens that support seek pagination, mapped to their direction. */
const SEEKABLE_SORTS: Readonly<Record<string, CursorDirection>> = {
  captured_desc: 'desc',
  captured_asc: 'asc',
};

/** The seek direction for a sort token, or `null` when that sort has no
 * cursor story and must stay on skip pagination. */
export function cursorDirectionFor(sort: string): CursorDirection | null {
  return SEEKABLE_SORTS[sort] ?? null;
}

/** Longest cursor we will even attempt to decode. A well-formed cursor is
 * ~90 chars; the cap bounds the work a hostile caller can force. */
const MAX_CURSOR_CHARS = 512;
/** Longest `captured_at` we accept back. ISO-8601 with offset is 29. */
const MAX_VALUE_CHARS = 64;
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/;

export function encodeCursor(c: SeekCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/**
 * Decode + validate a client-supplied cursor. Returns `null` for anything
 * malformed, oversized, or carrying a non-primitive `v` — the caller turns
 * that into a 400 rather than guessing at the caller's intent, because
 * silently ignoring a bad cursor would restart the scroll at page 0 and
 * duplicate every row the user has already seen.
 */
export function decodeCursor(raw: string): SeekCursor | null {
  if (raw.length === 0 || raw.length > MAX_CURSOR_CHARS) return null;
  const parsed = ((): unknown => {
    try {
      return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
      return undefined;
    }
  })();
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const { v, i, d } = parsed as Record<string, unknown>;
  if (d !== 'asc' && d !== 'desc') return null;
  if (typeof i !== 'string' || !OBJECT_ID_HEX.test(i)) return null;
  if (v !== null && (typeof v !== 'string' || v.length > MAX_VALUE_CHARS)) return null;
  return { v, i, d };
}

/** Mint the cursor a client should send to fetch the page after `doc`. */
export function cursorFromDoc(
  doc: { _id: ObjectId; exif?: { captured_at?: string | null } | null },
  direction: CursorDirection,
): SeekCursor {
  const capturedAt = doc.exif?.captured_at;
  return {
    v: typeof capturedAt === 'string' ? capturedAt : null,
    i: doc._id.toHexString(),
    d: direction,
  };
}

/**
 * The range predicate that resumes iteration after `cursor`, in the sort
 * order `{ 'exif.captured_at': ±1, _id: 1 }`. Callers `$and` this with the
 * request's own filter — never merge it in, since the filter may already
 * carry a top-level `$or`.
 */
export function seekFilter(cursor: SeekCursor): Filter<AssetDoc> {
  const id = new ObjectId(cursor.i);
  const tiebreak = { [CAPTURED_AT]: cursor.v, _id: { $gt: id } };

  if (cursor.v === null) {
    // Inside the null/missing group. Descending, that group is the tail, so
    // nothing follows it; ascending, every string row still follows.
    const rest = { [CAPTURED_AT]: null, _id: { $gt: id } };
    return (
      cursor.d === 'desc' ? rest : { $or: [rest, { [CAPTURED_AT]: { $type: 'string' } }] }
    ) as Filter<AssetDoc>;
  }

  const beyond =
    cursor.d === 'desc'
      ? { [CAPTURED_AT]: { $lt: cursor.v } }
      : { [CAPTURED_AT]: { $gt: cursor.v } };
  // Descending, the null/missing group sorts after every string, so it has
  // to ride along in the same `$or` — Mongo's sort+limit only reaches it
  // once the strings are exhausted. Ascending it sorts *before* every
  // string and has already been consumed by the time `v` is a string.
  const branches =
    cursor.d === 'desc' ? [beyond, tiebreak, { [CAPTURED_AT]: null }] : [beyond, tiebreak];
  return { $or: branches } as Filter<AssetDoc>;
}
