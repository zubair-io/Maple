/**
 * The four conversions every ported repository in #3751 needs, in one place so
 * they cannot drift into four slightly different opinions.
 *
 * Each one exists because MongoDB and SQLite disagree about a type the DTOs
 * are already committed to:
 *
 *   - **Identifiers.** The DTOs carry `ObjectId`. The tables carry the same
 *     24-character hex as TEXT (`docs/sqlite-schema.md` § keys), so every
 *     boundary crossing is one of {@link toHex} / {@link toObjectId}.
 *   - **Booleans.** SQLite has none; the schema spells them `INTEGER CHECK (x
 *     IN (0, 1))`. {@link toBool} reads one back, and a write binds `? 1 : 0`
 *     inline where it is obvious.
 *   - **Instants.** Some documents store an ISO string and some store a BSON
 *     `Date`, and which is which is not a style choice — the `Date`-typed ones
 *     are precisely the fields a Mongo TTL index swept, because the TTL monitor
 *     ignores strings. Every timestamp is TEXT in SQLite, so a repository whose
 *     DTO promises a `Date` converts on the way out with {@link toDate}.
 *   - **Payloads.** A JSON column is TEXT. {@link parseJson} is the read side,
 *     narrowed to "give me back what I put in or the fallback" rather than
 *     pretending to validate.
 */

import { ObjectId } from '../object-id.ts';

/** An id as the tables store it. */
export function toHex(id: ObjectId): string {
  return id.toHexString();
}

/** A stored id as the DTOs carry it. */
export function toObjectId(hex: string): ObjectId {
  return new ObjectId(hex);
}

/** A stored id as the DTOs carry it, or null for an absent column. */
export function toObjectIdOrNull(hex: string | null | undefined): ObjectId | null {
  return hex === null || hex === undefined ? null : new ObjectId(hex);
}

/** A `0` / `1` column as a boolean. Anything else (a NULL column) reads false. */
export function toBool(value: number | null | undefined): boolean {
  return value === 1;
}

/** A boolean as the column stores it. */
export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}

/**
 * An ISO 8601 timestamp column as the `Date` its DTO promises.
 *
 * Every timestamp in this schema is stored as ISO 8601 in UTC, which sorts
 * lexically, so the column is a correct range-scan key and this conversion is
 * only ever needed at the DTO boundary.
 */
export function toDate(iso: string): Date {
  return new Date(iso);
}

/** As {@link toDate}, for a nullable column. */
export function toDateOrNull(iso: string | null | undefined): Date | null {
  return iso === null || iso === undefined ? null : new Date(iso);
}

/** Now, in the form every timestamp column takes. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A JSON column's contents, or `fallback` when the column is NULL.
 *
 * Deliberately does not catch: a `json_valid` CHECK constraint guards every
 * JSON column in this schema, so unparseable text in one is a corrupted
 * database rather than a case a repository should paper over.
 */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  return JSON.parse(text) as T;
}

/**
 * `?, ?, ?` for an `IN (…)` list of `count` bound values.
 *
 * Deliberately positional rather than `json_each` over a single bound array:
 * a positional list gives the planner literal values it can turn into index
 * probes, where a subquery over a table-valued function makes it build an
 * ephemeral index first.
 */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}
