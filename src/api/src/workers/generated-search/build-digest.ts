/**
 * Per-run aggregation: the live library reduced to the small block of facts
 * the model cannot infer.
 *
 * The people roster is the sensitive part. A name that reaches the prompt is
 * a name the model may build a collection around and put on an unattended
 * screen, so it is filtered exactly the way the search index filters
 * searchable names — hidden out (soft-hide has to actually hold), excluded out
 * (#2894), merged rows out, and auto-generated `Person N` clusters out.
 * Withholding beats post-filtering: the model never learns a hidden person
 * exists, so it cannot theme on them in the first place. That rule is now one
 * SQL predicate shared with the search-index stage
 * (`repos/people.search-filter.ts`) rather than a filter each caller writes
 * out, because the two drifting apart is precisely how a hidden person reaches
 * a living-room screen.
 *
 * Every read here is a repository call (#3787); nothing in this file knows what
 * the storage engine is.
 */

import { meilisearchClient } from '../../enrichment/meilisearch-client.ts';
import { capturedYearCounts } from '../../db/sqlite/repos/assets.sweeps.ts';
import { recentGeneratedSearchThemes } from '../../db/sqlite/repos/generated-searches.repo.ts';
import { indexableRosterNames } from '../../db/sqlite/repos/people.search-filter.ts';
import { credibleYears } from './digest.ts';
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

/** Everything the proposal prompt needs about this library, today. */
export async function buildDigest(libraryId: string, now: Date): Promise<PromptDigest> {
  const month = now.getUTCMonth() + 1;
  const themesSinceIso = new Date(now.getTime() - RECENT_THEME_DAYS * DAY_MS).toISOString();

  const [people, years, thisMonth, themes] = await Promise.all([
    indexableRosterNames(),
    capturedYearCounts(libraryId, null),
    // Per-year counts within the current month — the anniversary signal.
    // Deliberately unfiltered by volume, so the model can see a thin year and
    // avoid it.
    capturedYearCounts(libraryId, month),
    recentGeneratedSearchThemes(libraryId, themesSinceIso),
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
