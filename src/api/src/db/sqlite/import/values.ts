/**
 * BSON → SQLite value conversion.
 *
 * Every rule in here exists because the two engines disagree about a type the
 * schema depends on, and getting one wrong is silent: SQLite stores whatever it
 * is handed, so an `ObjectId` that reached a TEXT column as `[object Object]`
 * would only surface later as a broken client id.
 *
 * The rules:
 *
 *  - **Identifiers stay identifiers.** An `ObjectId` becomes its 24-character
 *    lowercase hex — the exact string `assets.transform.ts` already puts on the
 *    wire — so every client-visible key survives the engine swap byte for byte.
 *  - **Dates become ISO 8601 strings**, because that is what the schema's TEXT
 *    timestamp columns hold and what sorts correctly as a string in UTC. A few
 *    Mongo fields are epoch milliseconds instead (`mtime`, the claim leases on
 *    `mirror_queue` and `discover_frontier`); those stay numbers.
 *  - **Booleans become 0 / 1**, which every `CHECK (… IN (0, 1))` in the schema
 *    expects.
 *  - **Nested payloads become JSON text**, with `ObjectId`, `Date` and `Binary`
 *    normalised on the way through. `JSON.stringify` would in fact render an
 *    `ObjectId` as its hex and a `Date` as ISO on its own, but only because
 *    both types happen to define `toJSON`; relying on that would make the
 *    correctness of every stored payload depend on a driver implementation
 *    detail nothing here controls.
 */

import { Binary, ObjectId } from 'mongodb';
import { isObjectIdHex } from '../object-id.ts';

/** The 24-character hex of an id that may arrive as an `ObjectId` or a string. */
export function idToHex(value: unknown): string | null {
  if (value instanceof ObjectId) return value.toHexString();
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    return isObjectIdHex(lowered) ? lowered : null;
  }
  return null;
}

/**
 * Like {@link idToHex} but for a column that cannot be null. Throws with the
 * offending value so the row lands in the reject list with a usable reason
 * rather than tripping a `CHECK (length(id) = 24)` several frames away.
 */
export function requireIdHex(value: unknown, field: string): string {
  const hex = idToHex(value);
  if (hex === null) throw new Error(`${field}: expected an ObjectId, got ${describe(value)}`);
  return hex;
}

/** ISO 8601 for a value stored as a BSON date, an ISO string, or epoch ms. */
export function toIso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return null;
}

/** Epoch milliseconds for a value stored as a number or a BSON date. */
export function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  return null;
}

/** 0 / 1 for a `CHECK (… IN (0, 1))` column. Absent reads as false. */
export function toBit(value: unknown): number {
  return value === true || value === 1 ? 1 : 0;
}

/** 0 / 1 / null, for the three nullable boolean columns in the schema. */
export function toNullableBit(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return toBit(value);
}

/** A finite number, or null. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/** A finite number with a floor value for a NOT NULL numeric column. */
export function numberOr(value: unknown, fallback: number): number {
  return toNumber(value) ?? fallback;
}

/** An integer with a floor value for a NOT NULL integer column. */
export function intOr(value: unknown, fallback: number): number {
  const n = toNumber(value);
  return n === null ? fallback : Math.trunc(n);
}

/** A non-empty string, or null. */
export function toText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A string with a floor value for a NOT NULL text column. */
export function textOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * A string constrained to a `CHECK (… IN (…))` list. Anything outside the list
 * — including a value a newer server version wrote — becomes null rather than
 * failing the row, because the alternative is losing the whole asset over one
 * enum field.
 */
export function toEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** As {@link toEnum}, with a fallback for a NOT NULL enum column. */
export function enumOr<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return toEnum(value, allowed) ?? fallback;
}

/** An integer clamped into an inclusive range, for a `CHECK (… BETWEEN …)`. */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = toNumber(value);
  if (n === null) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Replaces the BSON types a JSON column cannot hold with their canonical text
 * form: `ObjectId` with its hex, `Date` with ISO 8601, `Binary` with base64.
 * Everything else is walked structurally so a nested id deep inside a vision
 * payload is converted too.
 */
export function normaliseJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Binary) return value.toString('base64');
  if (Array.isArray(value)) return value.map(normaliseJson);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (inner === undefined) continue;
      out[key] = normaliseJson(inner);
    }
    return out;
  }
  if (typeof value === 'bigint') return Number(value);
  return value;
}

/**
 * JSON text for a `CHECK (json_valid(…))` column, or null when the source field
 * is absent. An empty object or array is preserved — `{}` and "the stage never
 * ran" are different states and the schema can tell them apart.
 */
export function toJsonText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(normaliseJson(value));
}

/** Bytes for a BLOB column, from a `Binary`, a `Buffer` or a base64 string. */
export function toBlob(value: unknown): Uint8Array | null {
  if (value instanceof Binary) return new Uint8Array(value.buffer);
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return Uint8Array.from(Buffer.from(value, 'base64'));
  return null;
}

/** A short, safe rendering of an unexpected value for an error message. */
export function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const text = typeof value === 'object' ? JSON.stringify(normaliseJson(value)) : String(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/** Narrowing helper for the document shapes the mappers read field-by-field. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** The entries of an array-valued field, or an empty list when it is absent. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
