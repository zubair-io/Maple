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

function peopleFilter(people: string[] | undefined): string | null {
  const names = (people ?? [])
    .map((person) => person.trim())
    .filter(Boolean)
    .map((person) => `"${person.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return names.length === 0 ? null : `people IN [${names.join(', ')}]`;
}

function mediaFilter(mediaTypes: MeilisearchMediaType[] | undefined): string | null {
  const allowed = new Set<MeilisearchMediaType>(['image', 'video', 'audio']);
  const selected = [...new Set((mediaTypes ?? []).filter((value) => allowed.has(value)))];
  return selected.length === 0
    ? null
    : `mediaType IN [${selected.map((value) => `"${value}"`).join(', ')}]`;
}

/** Hidden-mode clause: `onlyHidden` narrows to hidden docs (`hidden = true`,
 * keeps `hidden=only` pages dense — #2358), `includeHidden` lifts the
 * default exclusion, default excludes hidden docs. */
function hiddenFilter(opts: MeilisearchSearchOptions): string | null {
  if (opts.onlyHidden === true) return 'hidden = true';
  return opts.includeHidden === true ? null : '(hidden IS NULL OR hidden = false)';
}

export function buildFilter(opts: MeilisearchSearchOptions): string {
  const clauses = [
    'deletedAt IS NULL',
    hiddenFilter(opts),
    folderFilter(opts.folderId),
    peopleFilter(opts.people),
    mediaFilter(opts.mediaTypes),
  ].filter((clause): clause is string => clause !== null);
  return clauses.join(' AND ');
}
