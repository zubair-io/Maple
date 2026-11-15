/**
 * Validation of the `POST /api/service/photos/search` body.
 *
 * `from` and `to` take a date (`2024-07-04`) or a date-time (`2024-07-04T10:30`, seconds and
 * fraction optional). Both are inclusive at the precision given: `to: '2024-07-04'` reaches the
 * day's last millisecond and `to: '2024-07-04T10:30'` the minute's. Capture times are the camera's
 * wall clock (see `db/repos/service-photos.where.ts`), so a bound's wall clock is compared as
 * written and any offset or `Z` on it is ignored.
 */

const PERSON_ID = /^[a-f0-9]{24}$/;
const BOUND =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const MAX_PEOPLE = 20;
const MAX_PLACE_LENGTH = 200;
const MAX_QUERY_LENGTH = 500;
const MAX_CURSOR_LENGTH = 1_000;
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

export interface PhotoSearchRequest {
  personIds: string[];
  place: string | null;
  capturedFrom: string | null;
  capturedTo: string | null;
  query: string | null;
  limit: number;
  cursor: string | null;
}

export type ParsedSearch =
  | { ok: true; request: PhotoSearchRequest }
  | { ok: false; message: string };

type Edge = 'start' | 'end';

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** A bound in the stored `YYYY-MM-DDTHH:MM:SS.sssZ` form, widened to `edge` of its precision. */
function parseCaptureBound(value: string, edge: Edge): string | null {
  const match = BOUND.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, fraction] = match;
  const fill = (part: string | undefined, start: number, end: number): number =>
    part === undefined ? (edge === 'start' ? start : end) : Number(part);
  const hour = fill(h, 0, 23);
  const minute = fill(mi, 0, 59);
  const second = fill(s, 0, 59);
  const millis = fraction === undefined ? fill(undefined, 0, 999) : fractionMillis(fraction, edge);
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, minute, second));
  if (!isRealTime(date, [Number(y), Number(mo), Number(d)], [hour, minute, second])) return null;
  // A start rounded up past .999 carries into the next second (or later), which still sorts right.
  return millis < 1000
    ? `${y}-${mo}-${d}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(millis, 3)}Z`
    : new Date(date.getTime() + millis).toISOString();
}

/** Whether the parts name a real wall-clock time (no 31 June, no 24:00, no :60). */
function isRealTime(
  date: Date,
  [year, month, day]: [number, number, number],
  [hour, minute, second]: [number, number, number],
): boolean {
  return (
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * The stored millisecond a fraction reaches at `edge` of its precision. Capture times keep whole
 * milliseconds, so `end` covers the given precision's last one (`.1` → 199) and drops digits past
 * the third (`.1009` → 100); `start` pads with zeroes (`.1` → 100) and rounds a sub-millisecond
 * remainder up (`.1001` → 101), so no earlier capture is let in.
 */
function fractionMillis(fraction: string, edge: Edge): number {
  if (fraction.length <= 3) return Number(fraction.padEnd(3, edge === 'start' ? '0' : '9'));
  const whole = Number(fraction.slice(0, 3));
  const rest = /[1-9]/.test(fraction.slice(3));
  return edge === 'start' && rest ? whole + 1 : whole;
}

function optionalText(value: unknown, max: number, field: string): string | null | Error {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) {
    return new Error(`${field} must be a string of at most ${max} characters.`);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parsePeople(value: unknown): string[] | Error {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_PEOPLE) {
    return new Error(`people must be an array of at most ${MAX_PEOPLE} person ids.`);
  }
  const ids = value.map((id) => (typeof id === 'string' ? id.toLowerCase() : ''));
  return ids.every((id) => PERSON_ID.test(id))
    ? [...new Set(ids)]
    : new Error('people must contain person ids (24 hexadecimal characters).');
}

function parseLimit(value: unknown): number | Error {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_LIMIT
    ? (value as number)
    : new Error(`limit must be an integer from 1 to ${MAX_LIMIT}.`);
}

function parseBound(value: unknown, edge: Edge, field: string): string | null | Error {
  if (value === undefined || value === null) return null;
  const parsed = typeof value === 'string' ? parseCaptureBound(value, edge) : null;
  return parsed ?? new Error(`${field} must be an ISO 8601 date or date-time.`);
}

export function parseSearchBody(body: unknown): ParsedSearch {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  const input = body as Record<string, unknown>;
  const fields = {
    personIds: parsePeople(input.people),
    place: optionalText(input.place, MAX_PLACE_LENGTH, 'place'),
    capturedFrom: parseBound(input.from, 'start', 'from'),
    capturedTo: parseBound(input.to, 'end', 'to'),
    query: optionalText(input.query, MAX_QUERY_LENGTH, 'query'),
    limit: parseLimit(input.limit),
    cursor: optionalText(input.cursor, MAX_CURSOR_LENGTH, 'cursor'),
  };
  const failure = Object.values(fields).find((value): value is Error => value instanceof Error);
  if (failure) return { ok: false, message: failure.message };
  const request = fields as PhotoSearchRequest;
  if (
    request.capturedFrom !== null &&
    request.capturedTo !== null &&
    request.capturedFrom > request.capturedTo
  ) {
    return { ok: false, message: 'from must not be after to.' };
  }
  const filtered =
    request.personIds.length > 0 ||
    request.place !== null ||
    request.capturedFrom !== null ||
    request.capturedTo !== null ||
    request.query !== null;
  return filtered
    ? { ok: true, request }
    : { ok: false, message: 'Give at least one of people, place, from, to or query.' };
}
