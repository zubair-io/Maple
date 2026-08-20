/**
 * The gate between raw Ollama JSON and a query the generated-search worker
 * will execute.
 *
 * The model is grammar-constrained by a `format` JSON Schema, but that is
 * best-effort — Ollama < 0.5 ignores `format`, providers get swapped, and a
 * thinking model can route output through a path that bypasses the grammar
 * (#2172). So this is the real boundary. Same defense-in-depth stance
 * `parse-vision-json` takes toward the describe stage.
 *
 * Construction is whitelist-only: the result is built key-by-key from
 * `ALLOWED_KEYS`, so a field the model invents cannot survive by accident.
 * That matters most for `rating` (filters `$gte`, so a volunteered
 * `rating: 1` would exclude every unrated photo), and for
 * `excludeHiddenPeople` / `hidden` / `isScreenshot` / `libraryId`, which the
 * server forces at execution time and must never take from stored data.
 *
 * Two rules fail closed rather than degrade:
 *   - a person name outside the roster the model was shown. The digest
 *     withholds soft-hidden people, so an unknown name is either a
 *     hallucination or a guessed hidden person; neither may reach a query.
 *   - a date range outside credible coverage. Observed live: a model wrote
 *     `from: 2013-06-01` against a library starting in 2016, and 1,931
 *     assets carry an 1899 OLE-epoch sentinel year that would clear any
 *     result-count floor while being pure garbage.
 */

import { ALLOWED_SCENE_TYPE } from '../../enrichment/describe-providers/parse-vision-json-enums.ts';

/** The only query keys the model may influence. Everything else in
 * `SearchQuery` is server-controlled. */
const ALLOWED_KEYS = ['placeQuery', 'from', 'to', 'month', 'people', 'sceneType'] as const;

/** Bare `YYYY-MM-DD`, the only date form the model may emit. */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface GeneratedQuery {
  placeQuery?: string;
  from?: string;
  to?: string;
  /** Recurring month-of-year as a query-string value, `"1"`–`"12"`. */
  month?: string;
  people?: string;
  sceneType?: string;
}

export interface ProposedCollection {
  theme: string;
  query: GeneratedQuery;
}

export interface ValidationContext {
  /** Non-hidden person names the digest showed the model. */
  allowedPeople: readonly string[];
  /** Years with credible coverage — sentinel and sub-threshold years are
   * filtered out before they reach the prompt, and again here. */
  coverageYears: readonly number[];
}

export type ValidationResult =
  | { ok: true; value: ProposedCollection }
  | { ok: false; reason: string };

const reject = (reason: string): ValidationResult => ({ ok: false, reason });

/** Non-empty trimmed string, or undefined for null/absent/blank. */
function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** `from`/`to`: bare `YYYY-MM-DD`, inside credible coverage. */
function readDate(
  key: 'from' | 'to',
  raw: unknown,
  ctx: ValidationContext,
): { value?: string } | { reason: string } {
  const value = asText(raw);
  if (value === undefined) return {};
  if (!BARE_DATE.test(value)) return { reason: `${key} is not YYYY-MM-DD: ${value}` };
  const year = Number(value.slice(0, 4));
  if (!ctx.coverageYears.includes(year)) {
    return { reason: `${key} year ${year} is outside library coverage` };
  }
  return { value };
}

/** Recurring month-of-year, 1-12. */
function readMonth(raw: unknown): { value?: string } | { reason: string } {
  if (raw === undefined || raw === null) return {};
  const month = Number(raw);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return { reason: `month out of range: ${String(raw)}` };
  }
  return { value: String(month) };
}

/** Person names, every one of which must be on the roster the model was
 * shown. Fails closed: an unknown name is either a hallucination or a hidden
 * person the model guessed, and neither may reach a query. */
function readPeople(raw: unknown, ctx: ValidationContext): { value?: string } | { reason: string } {
  const people = asText(raw);
  if (people === undefined) return {};
  const names = people
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const unknown = names.filter((name) => !ctx.allowedPeople.includes(name));
  if (unknown.length > 0) return { reason: `unknown people: ${unknown.join(', ')}` };
  return names.length > 0 ? { value: names.join(',') } : {};
}

/** Closed enum, shared with the describe stage's vision schema. */
function readSceneType(raw: unknown): { value?: string } | { reason: string } {
  const sceneType = asText(raw);
  if (sceneType === undefined) return {};
  if (!ALLOWED_SCENE_TYPE.has(sceneType)) return { reason: `unknown sceneType: ${sceneType}` };
  return { value: sceneType };
}

export function validateProposal(raw: unknown, ctx: ValidationContext): ValidationResult {
  if (typeof raw !== 'object' || raw === null) return reject('not an object');
  const proposal = raw as Record<string, unknown>;

  const theme = asText(proposal.theme);
  if (theme === undefined) return reject('missing theme');

  const rawQuery = proposal.query;
  if (typeof rawQuery !== 'object' || rawQuery === null) return reject('missing query');
  const source = rawQuery as Record<string, unknown>;

  // Whitelist construction: the query is rebuilt field by field, so a key the
  // model invents cannot survive by accident.
  const fields: Record<string, { value?: string } | { reason: string }> = {
    placeQuery: { value: asText(source.placeQuery) },
    from: readDate('from', source.from, ctx),
    to: readDate('to', source.to, ctx),
    month: readMonth(source.month),
    people: readPeople(source.people, ctx),
    sceneType: readSceneType(source.sceneType),
  };

  const query: GeneratedQuery = {};
  for (const [key, outcome] of Object.entries(fields)) {
    if ('reason' in outcome) return reject(outcome.reason);
    if (outcome.value !== undefined) query[key as keyof GeneratedQuery] = outcome.value;
  }

  // An all-null query executes as "the entire library" — it would clear the
  // result floor every time and is never a collection.
  if (ALLOWED_KEYS.every((key) => query[key] === undefined)) {
    return reject('query has no usable filter');
  }

  return { ok: true, value: { theme, query } };
}
