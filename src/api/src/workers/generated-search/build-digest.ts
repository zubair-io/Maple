/**
 * Per-run aggregation: the live library reduced to the small block of facts
 * the model cannot infer.
 *
 * The people roster is the sensitive part. A name that reaches the prompt is
 * a name the model may build a collection around and put on an unattended
 * screen, so it is filtered exactly the way `stages/meili.ts` filters
 * searchable names — hidden out (soft-hide has to actually hold), excluded
 * out (#2894), merged rows out, and auto-generated `Person N` clusters out.
 * Withholding beats post-filtering: the model never learns a hidden person
 * exists, so it cannot theme on them in the first place.
 */

import { ObjectId } from 'mongodb';
import { meilisearchClient } from '../../enrichment/meilisearch-client.ts';
import { getDb } from '../../db/client.ts';
import { AUTO_PERSON_NAME } from '../../people/auto-person-name.ts';
import { credibleYears, type YearCount } from './digest.ts';
import type { PromptDigest } from './prompt.ts';

/** How far back to look for themes the model should not repeat. */
const RECENT_THEME_DAYS = 14;
const DAY_MS = 86_400_000;

/** Long-form date for the prompt header, e.g. "Monday, 17 August 2026". */
function formatToday(now: Date): string {
  return now.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Names the model may use. Mirrors the meili stage's visibility filter. */
async function rosterNames(): Promise<string[]> {
  const people = (await getDb()).collection('people');
  const rows = await people
    .find(
      { merged_into: null, hidden: { $ne: true }, excluded: { $ne: true } },
      { projection: { name: 1 } },
    )
    .toArray();

  return rows
    .map((row) => (row as { name?: unknown }).name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
    .filter((name) => !AUTO_PERSON_NAME.test(name));
}

/** Per-year asset counts for one library. */
async function yearCounts(libraryId: ObjectId): Promise<YearCount[]> {
  const assets = (await getDb()).collection('assets');
  const rows = await assets
    .aggregate([
      { $match: { 'fileinfo.library_id': libraryId, 'exif.captured_year': { $type: 'number' } } },
      { $group: { _id: '$exif.captured_year', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  return rows.map((row) => ({ year: row._id as number, count: row.count as number }));
}

/** Per-year counts within one month — the anniversary signal. Reported
 * unfiltered by volume so the model can see a thin year and avoid it. */
async function monthCounts(libraryId: ObjectId, month: number): Promise<YearCount[]> {
  const assets = (await getDb()).collection('assets');
  const rows = await assets
    .aggregate([
      {
        $match: {
          'fileinfo.library_id': libraryId,
          'exif.captured_month': month,
          'exif.captured_year': { $type: 'number' },
        },
      },
      { $group: { _id: '$exif.captured_year', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  return rows.map((row) => ({ year: row._id as number, count: row.count as number }));
}

/** Themes from recent runs, so the model does not repeat itself. */
async function recentThemes(libraryId: string, now: Date): Promise<string[]> {
  const coll = (await getDb()).collection('generated_searches');
  const cutoffIso = new Date(now.getTime() - RECENT_THEME_DAYS * DAY_MS).toISOString();
  const rows = await coll
    .find(
      { library_id: libraryId, generated_at: { $gte: cutoffIso } },
      { projection: { theme: 1 } },
    )
    .toArray();
  return rows
    .map((row) => (row as { theme?: unknown }).theme)
    .filter((theme): theme is string => typeof theme === 'string' && theme.length > 0);
}

/** Everything the proposal prompt needs about this library, today. */
export async function buildDigest(libraryId: string, now: Date): Promise<PromptDigest> {
  const libObjectId = new ObjectId(libraryId);
  const month = now.getUTCMonth() + 1;

  const [people, years, thisMonth, themes] = await Promise.all([
    rosterNames(),
    yearCounts(libObjectId),
    monthCounts(libObjectId, month),
    recentThemes(libraryId, now),
  ]);

  // The sentinel/volume filter applies to coverage but NOT to the month
  // histogram: a thin year there is useful context ("2019 has 52 photos this
  // month"), whereas a thin year in COVERAGE would invite a collection that
  // cannot be filled.
  const credible = new Set(credibleYears(years));

  return {
    today: formatToday(now),
    people,
    coverageYears: [...credible].sort((a, b) => a - b),
    onThisMonthByYear: thisMonth.filter(({ year }) => credible.has(year)),
    recentThemes: themes,
    // Read fresh each run, not cached: an operator can flip semantic search
    // on from Settings and the next run's prompt should switch with it.
    semanticSearch: meilisearchClient().semanticConfigured(),
  };
}
