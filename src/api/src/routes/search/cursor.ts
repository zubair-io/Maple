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
 * ## The undated group
 *
 * `captured_at` is an ISO-8601 string or nothing at all, and the rows with
 * nothing form one contiguous group at one end of the order: the *tail*
 * under `captured_desc`, the *head* under `captured_asc`. A naive "less
 * than" seek walks off the end of the dated rows and drops that whole
 * group, so the cursor records which of the two groups its row came from
 * (`v: string` vs `v: null`) and the predicate built from it spans the
 * boundary exactly once.
 *
 * That predicate is `seekPredicate` in `db/sqlite/repos/search.sql.ts`,
 * beside the page statement whose `ORDER BY` it has to agree with — this
 * module owns the cursor's *shape* and its validation, not the SQL. Both
 * engines happen to put the undated group in the same place, MongoDB
 * because BSON sorts Null below String and SQLite because NULL sorts first
 * ascending and last descending, so the four cases are unchanged from the
 * Mongo original.
 *
 * ## Opacity + injection
 *
 * The cursor is base64url-encoded JSON, opaque to clients but never
 * trusted: `decodeCursor` rejects anything that isn't `{v: string|null,
 * i: <24 hex>, d: 'asc'|'desc'}`. The validation is not load-bearing for
 * injection any more — every part of the cursor is a bound parameter by the
 * time it reaches a statement — but it is still what stops a forged or
 * truncated cursor from silently restarting the scroll somewhere the user
 * has already been.
 */

// Type-only: an asset id is still a 24-character hex string on the wire, and
// `ObjectId` is how the document shape spells one. See the brief's note on ids.
import type { ObjectId } from 'mongodb';

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
