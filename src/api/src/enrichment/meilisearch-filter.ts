/**
 * Meilisearch filter-expression construction, extracted from
 * `meilisearch-client.ts` (file budget). Meili's filter syntax is
 * `field = "value" AND field IS NULL` — clauses are hand-built from typed
 * inputs rather than passing user strings through, so an attacker can't
 * inject filter clauses via `folderId` or a person name.
 */

import type { MeilisearchMediaType, MeilisearchSearchOptions } from './meilisearch-client.ts';

function folderFilter(folderId: string | undefined): string | null {
  const safe = folderId?.replace(/[^a-f0-9]/gi, '') ?? '';
  return safe.length === 0 ? null : `folderId = "${safe}"`;
}

/** A value as a Meili string literal. Backslash first, then the quote —
 * reversing the order would re-escape the backslashes this adds. Every
 * caller below routes user-supplied text through here; that is what keeps
 * the module header's "an attacker can't inject filter clauses" promise
 * true for open-vocabulary fields as well as closed ones. */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function peopleFilter(people: string[] | undefined): string | null {
  const names = (people ?? [])
    .map((person) => person.trim())
    .filter(Boolean)
    .map(quoted);
  return names.length === 0 ? null : `people IN [${names.join(', ')}]`;
}

function equalsFilter(field: string, value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 ? null : `${field} = ${quoted(trimmed)}`;
}

function subjectsFilter(subjects: string[] | undefined): string | null {
  const values = (subjects ?? [])
    .map((subject) => subject.trim())
    .filter(Boolean)
    .map(quoted);
  return values.length === 0 ? null : `visionSubjects IN [${values.join(', ')}]`;
}

/** Mirrors the Mongo predicate, which is `$ne: true` rather than `= false`:
 * rows indexed before `is_screenshot` was written must still count as
 * photographs, so the negative case has to admit a missing field. */
/**
 * `IS NULL` matches a field that is PRESENT and null; it does not match one
 * that is absent. `isScreenshot` only entered the document at shape v5, so
 * every document indexed before that carries no key at all and an `IS NULL`
 * test alone would silently drop all of them from "Photos only".
 * `NOT EXISTS` is the arm that covers them.
 *
 * The Mongo predicate this mirrors is `$ne: true`, which admits both shapes
 * for exactly the same reason.
 */
const NOT_A_SCREENSHOT =
  '(isScreenshot NOT EXISTS OR isScreenshot IS NULL OR isScreenshot = false)';

function screenshotFilter(isScreenshot: boolean | undefined): string | null {
  if (isScreenshot === undefined) return null;
  return isScreenshot ? 'isScreenshot = true' : NOT_A_SCREENSHOT;
}

function mediaFilter(mediaTypes: MeilisearchMediaType[] | undefined): string | null {
  const allowed = new Set<MeilisearchMediaType>(['image', 'video', 'audio']);
  const selected = [...new Set((mediaTypes ?? []).filter((value) => allowed.has(value)))];
  return selected.length === 0
    ? null
    : `mediaType IN [${selected.map((value) => `"${value}"`).join(', ')}]`;
}

/** The only shape a capture-date bound may take. Every other input here is
 * sanitised at the point of interpolation (`folderId` stripped to hex, person
 * names quote-escaped); these two were left to caller discipline, and a
 * caller that forwarded a raw wire string would have closed the literal early
 * and appended clauses — lifting the `hidden` exclusion or `folderId` scope.
 * Callers normalise; this makes the module's guarantee its own. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A bound that isn't a canonical instant is dropped, never interpolated.
 * Dropping only widens the Meilisearch candidate set — the caller's Mongo
 * predicate still applies the window, so results stay correct. */
function boundClause(op: string, bound: string | undefined): string[] {
  return bound !== undefined && ISO_INSTANT.test(bound) ? [`capturedAt ${op} "${bound}"`] : [];
}

function capturedAtFilters(opts: MeilisearchSearchOptions): string[] {
  return [...boundClause('>=', opts.capturedFrom), ...boundClause('<', opts.capturedBefore)];
}

/** Hidden-mode clause: `onlyHidden` narrows to hidden docs (`hidden = true`,
 * keeps `hidden=only` pages dense — #2358), `includeHidden` lifts the
 * default exclusion, default excludes hidden docs. */
function hiddenFilter(opts: MeilisearchSearchOptions): string | null {
  if (opts.onlyHidden === true) return 'hidden = true';
  // Same absent-field trap as `NOT_A_SCREENSHOT`: `hidden` arrived at shape
  // v3, so older documents carry no key and an `IS NULL` test alone drops
  // them from every default search. Widening is safe — `list-meili.ts`
  // re-applies the real hidden predicate in Mongo, so this only decides
  // which candidates are offered, never what ships.
  return opts.includeHidden === true
    ? null
    : '(hidden NOT EXISTS OR hidden IS NULL OR hidden = false)';
}

export function buildFilter(opts: MeilisearchSearchOptions): string {
  const clauses = [
    'deletedAt IS NULL',
    hiddenFilter(opts),
    folderFilter(opts.folderId),
    peopleFilter(opts.people),
    mediaFilter(opts.mediaTypes),
    equalsFilter('visionSceneType', opts.sceneType),
    equalsFilter('visionActivity', opts.activity),
    subjectsFilter(opts.subjects),
    screenshotFilter(opts.isScreenshot),
    ...capturedAtFilters(opts),
  ].filter((clause): clause is string => clause !== null);
  return clauses.join(' AND ');
}
