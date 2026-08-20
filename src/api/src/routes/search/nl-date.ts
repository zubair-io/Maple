/**
 * Conservative natural-language date parser for the smart search box.
 *
 * Scope is a deliberately small, closed set of forms the product owner
 * asked for — bare year, `Month [D][, YYYY]`, and QUALIFIED seasons and
 * holidays (`last winter`, `summer 2024`, `christmas 2023`). We do NOT pull
 * in `chrono-node`: it over-matches (e.g. "5" out of "ISO 5", a lone weekday
 * out of a brand name) and the resulting false date-strips would silently
 * drop real query words. A hand-rolled parser with explicit anchored
 * patterns is auditable and only fires on tokens that unambiguously read as
 * a date.
 *
 * That last hazard is not hypothetical, and it is why a BARE season or
 * holiday word no longer parses at all. `winter` matched, became a Dec–Feb
 * window, and was stripped — leaving the query with NO search text, so
 * `usesPlaceText()` went false, Meilisearch was never queried, and search
 * silently became "everything captured last winter, newest first" with no
 * relevance ranking (#2952). Those words describe how a photo LOOKS and
 * belong to the text query, where semantic search can answer them across
 * every year. A month or a year carries no such meaning, so both stay
 * temporal.
 *
 * Every branch returns a bare `YYYY-MM-DD` `from`/`to` pair (inclusive)
 * which flows into the existing `widenFromDate`/`widenToDate` day-widening
 * in `query.ts`, plus the exact substring it consumed so the caller can
 * strip it from the residual free-text query.
 */

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** Northern-hemisphere meteorological seasons → [startMonth, endMonth].
 * Winter wraps the year boundary; handled specially below. */
const SEASONS: Record<string, [number, number]> = {
  spring: [3, 5],
  summer: [6, 8],
  fall: [9, 11],
  autumn: [9, 11],
  winter: [12, 2],
};

export interface NlDateRange {
  /** Inclusive lower bound, bare `YYYY-MM-DD`. */
  from?: string;
  /** Inclusive upper bound, bare `YYYY-MM-DD`. */
  to?: string;
  /** The exact source substring the parser consumed, so the caller can
   * remove it from the residual free-text query. */
  matched?: string;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Days in a month, accounting for leap years (only February cares). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Whole-month range for a (year, month). */
function monthRange(year: number, month: number): NlDateRange {
  return {
    from: ymd(year, month, 1),
    to: ymd(year, month, daysInMonth(year, month)),
  };
}

/**
 * Parse a natural-language date out of `text`. Returns `null` when nothing
 * date-like is present. Only the FIRST recognised form fires — the search
 * box is a single intent, not a date arithmetic expression.
 *
 * `now` is injectable for deterministic tests; defaults to the current UTC
 * instant.
 */
export function parseNlDateRange(text: string, now: Date = new Date()): NlDateRange | null {
  const raw = text.trim();
  if (raw.length === 0) return null;
  const lower = raw.toLowerCase();

  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth() + 1;

  // Holiday names are deliberately absent: `christmas`, `halloween` and the
  // rest are THEMES, not dates. Measured against bge-m3, the query
  // "christmas" scores christmas sweaters .516, a tree with presents .509 and
  // carollers on a snowy street .506 — none of which contain the word — while
  // an unrelated app screenshot scores .333. Turning the word into a Dec-25
  // window threw all of that away and returned whatever happened to be shot
  // that day. A year written alongside it (`christmas 2024`) still filters,
  // via the bare-year rule below, which consumes only the digits and leaves
  // the theme word to be ranked (#2952).

  // ── Seasons ("last summer", "summer 2024", "summer") ──────────────────
  for (const [name, [startM, endM]] of Object.entries(SEASONS)) {
    const re = new RegExp(`\\b(last\\s+|this\\s+)?${name}(?:\\s+(\\d{4}))?\\b`, 'i');
    const m = re.exec(lower);
    if (!m) continue;
    const qualifier = (m[1] ?? '').trim().toLowerCase();
    // A bare season word describes how a photo LOOKS, and belongs to the text
    // query so semantic search can answer it across every year. Consuming it
    // here removed it from the query entirely: `winter` alone left NO search
    // text, so `usesPlaceText()` went false, Meilisearch was never called, and
    // the route degraded to "everything captured last winter, newest first"
    // with no relevance ranking (#2952). Temporal intent still wins when the
    // user actually states it — `last winter`, `this summer`, `winter 2024`.
    if (!m[2] && qualifier === '') continue;
    const isLast = qualifier === 'last';
    let year = m[2] ? Number.parseInt(m[2], 10) : nowYear;
    // Winter wraps Dec→Feb; anchor it on the year of its January/February
    // tail so "winter 2024" means Dec 2023 – Feb 2024 (the common reading).
    if (startM > endM) {
      if (!m[2]) {
        // Bare "winter" without a year: anchor on the Jan/Feb tail of the
        // most recent winter. That tail year is always the current year —
        // in Jan/Feb it's the ongoing winter (Dec last year → now); the rest
        // of the year it's the winter that just ended (e.g. May 2026 →
        // Dec 2025–Feb 2026). Never the future.
        year = nowYear;
      }
      if (isLast) year -= 1;
      return {
        from: ymd(year - 1, startM, 1),
        to: ymd(year, endM, daysInMonth(year, endM)),
        matched: m[0],
      };
    }
    if (!m[2] && isLast) year -= 1;
    return {
      from: ymd(year, startM, 1),
      to: ymd(year, endM, daysInMonth(year, endM)),
      matched: m[0],
    };
  }

  // ── Month [day][, year] ───────────────────────────────────────────────
  // "May", "May 5", "May 5, 2024", "May 2024", "5 May 2024".
  const monthAlt = Object.keys(MONTHS).join('|');

  // Form B FIRST: <day> <month> [year]. Tried ahead of the month-leading
  // form so "5 May 2024" reads as a specific day, not month+year.
  const reB = new RegExp(`\\b(\\d{1,2})\\s+(${monthAlt})\\b(?:\\s*,?\\s*(\\d{4}))?`, 'i');
  const mB = reB.exec(lower);
  if (mB) {
    const day = Number.parseInt(mB[1], 10);
    const month = MONTHS[mB[2].toLowerCase()];
    const yearStr = mB[3];
    const probeYear = yearStr ? Number.parseInt(yearStr, 10) : nowYear;
    if (day >= 1 && day <= daysInMonth(probeYear, month)) {
      const year = yearStr ? Number.parseInt(yearStr, 10) : mostRecentYearFor(month, day, now);
      return { from: ymd(year, month, day), to: ymd(year, month, day), matched: mB[0] };
    }
  }

  // Form A: <month> [day] [, year]. The day group uses a `(?!\d)` guard so
  // it can't swallow the leading digits of a 4-digit year ("May 2024" must
  // read as month+year, not day=20 + "24").
  const reA = new RegExp(
    `\\b(${monthAlt})\\b(?:\\s+(\\d{1,2})(?!\\d))?(?:\\s*,?\\s*(\\d{4}))?`,
    'i',
  );
  const mA = reA.exec(lower);
  if (mA) {
    const month = MONTHS[mA[1].toLowerCase()];
    const dayStr = mA[2];
    const yearStr = mA[3];
    if (dayStr !== undefined) {
      const day = Number.parseInt(dayStr, 10);
      // Reject impossible day-of-month (e.g. "may 99") — treat as non-date.
      const probeYear = yearStr ? Number.parseInt(yearStr, 10) : nowYear;
      if (day >= 1 && day <= daysInMonth(probeYear, month)) {
        const year = yearStr ? Number.parseInt(yearStr, 10) : mostRecentYearFor(month, day, now);
        return { from: ymd(year, month, day), to: ymd(year, month, day), matched: mA[0] };
      }
      // Day present but invalid — fall through to non-date.
    } else if (yearStr !== undefined) {
      return { ...monthRange(Number.parseInt(yearStr, 10), month), matched: mA[0] };
    } else {
      // Bare month name → most recent occurrence of that whole month.
      const year = month <= nowMonth ? nowYear : nowYear - 1;
      return { ...monthRange(year, month), matched: mA[0] };
    }
  }

  // ── ISO `YYYY-MM-DD` embedded in the text ─────────────────────────────
  const reIso = /\b(\d{4})-(\d{2})-(\d{2})\b/;
  const mIso = reIso.exec(raw);
  if (mIso) {
    const y = Number.parseInt(mIso[1], 10);
    const mo = Number.parseInt(mIso[2], 10);
    const d = Number.parseInt(mIso[3], 10);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)) {
      return { from: mIso[0], to: mIso[0], matched: mIso[0] };
    }
  }

  // ── Bare year ─────────────────────────────────────────────────────────
  // Only when the year stands alone as a whole token surrounded by word
  // boundaries AND the residual would not be a more specific form (handled
  // above). Restrict to a plausible photo-era range so "iso 6400" or a
  // serial number doesn't read as a year.
  const reYear = /\b(19\d{2}|20\d{2})\b/;
  const mYear = reYear.exec(lower);
  if (mYear) {
    const year = Number.parseInt(mYear[1], 10);
    return {
      from: ymd(year, 1, 1),
      to: ymd(year, 12, 31),
      matched: mYear[0],
    };
  }

  return null;
}

/** Most recent past (or today) occurrence of a fixed month/day relative to
 * `now`. "May 5" in June 2026 → 2026-05-05; in April 2026 → 2025-05-05. */
function mostRecentYearFor(month: number, day: number, now: Date): number {
  const year = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth() + 1;
  const nowDay = now.getUTCDate();
  if (month < nowMonth || (month === nowMonth && day <= nowDay)) return year;
  return year - 1;
}
