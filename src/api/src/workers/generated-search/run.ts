/**
 * Generated-search maintenance job: one pass per library per day, plus the
 * interval wrapper that schedules it.
 *
 * A library-wide, interval-fired job — NOT a per-asset stage. Stages in
 * `workers/stages/` exist to bring every asset to a version; this produces a
 * handful of library-level documents on a schedule, which is why it lives
 * beside trash-gc and dedupe in `maintenance.ts`.
 *
 * Starts PAUSED (see `config.repo.ts`). The job needs Ollama configured and
 * reachable, and a paused start keeps a fresh install from quietly filling
 * the widget with junk before an operator has looked at it.
 */

import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { loadEnrichmentConfig } from '../../enrichment/enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from '../../enrichment/enrichment-config.resolve.ts';
import { child as childLogger } from '../../log.ts';
import { buildDigest } from './build-digest.ts';
import { loadGeneratedSearchConfig } from './config.repo.ts';
import { runProposalLoop } from './loop.ts';
import { createOllamaJsonClient } from './ollama-adapter.ts';
import { saveGeneratedSearches, pruneGeneratedSearches } from './repo.ts';
import { runGeneratedSearch } from './search-adapter.ts';

const log = childLogger('generated-search');
const DAY_MS = 86_400_000;

export interface GeneratedSearchSummary {
  libraries: number;
  saved: number;
  pruned: number;
  skipped: boolean;
}

/** `YYYY-MM-DD` in UTC — the key a day's collections are grouped under. */
function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * One pass over every library. Exported for tests and for an operator-
 * triggered run; the interval wrapper below simply calls it.
 */
/** One library's pass: digest, propose/measure/title, persist. Returns how
 * many collections were saved. */
async function runForLibrary(
  libraryId: string,
  ctx: {
    client: { generateJson: (prompt: string, schema: unknown) => Promise<unknown> };
    config: Awaited<ReturnType<typeof loadGeneratedSearchConfig>>;
    model: string;
    generatedFor: string;
    generatedAt: string;
    now: Date;
  },
): Promise<number> {
  const digest = await buildDigest(libraryId, ctx.now);
  const collections = await runProposalLoop({
    generateJson: (prompt, schema) => ctx.client.generateJson(prompt, schema),
    runSearch: runGeneratedSearch,
    digest,
    validationContext: { allowedPeople: digest.people, coverageYears: digest.coverageYears },
    libraryId,
    generatedFor: ctx.generatedFor,
    generatedAt: ctx.generatedAt,
    model: ctx.model,
    count: ctx.config.collections_per_day,
    minResults: ctx.config.min_results,
    maxRounds: ctx.config.max_rounds,
  });

  if (ctx.config.dry_run) {
    // Everything ran; nothing is written. Lets an operator evaluate a prompt
    // change against the real library before enabling the job.
    log.info(
      {
        libraryId,
        would_save: collections.map((c) => ({
          theme: c.theme,
          title: c.title,
          count: c.result_count,
        })),
      },
      'dry run — not persisting',
    );
    return 0;
  }

  await saveGeneratedSearches(collections);
  if (collections.length < ctx.config.collections_per_day) {
    // A partial day is legitimate, but the operator should be able to see it
    // happened rather than wonder why the widget has two cards.
    log.info(
      { libraryId, saved: collections.length, wanted: ctx.config.collections_per_day },
      'run produced fewer collections than requested',
    );
  }
  return collections.length;
}

/**
 * One pass over every library. Exported for tests and for an operator-
 * triggered run; the interval wrapper below simply calls it.
 */
export async function runGeneratedSearchOnce(
  now: Date = new Date(),
): Promise<GeneratedSearchSummary> {
  const config = await loadGeneratedSearchConfig();
  if (config.paused) {
    return { libraries: 0, saved: 0, pruned: 0, skipped: true };
  }

  // The model and Ollama endpoint come from the describe stage's enrichment
  // config, so an operator configures Ollama once rather than twice. A
  // per-job `model` override exists because the best model for curating text
  // is not necessarily the vision model that captions photos.
  const enrichment = resolveEnrichmentConfig(await loadEnrichmentConfig());
  const model = config.model.length > 0 ? config.model : enrichment.describe_model;
  const ctx = {
    client: createOllamaJsonClient(enrichment.describe_provider_url, model),
    config,
    model,
    generatedFor: dayKey(now),
    generatedAt: now.toISOString(),
    now,
  };

  const libraries = [...(await loadLibraryRoots()).keys()];
  let saved = 0;
  for (const libraryId of libraries) {
    try {
      saved += await runForLibrary(libraryId, ctx);
    } catch (err) {
      // One library's failure must not abort the others.
      log.warn(
        { libraryId, err: err instanceof Error ? err.message : String(err) },
        'library pass failed',
      );
    }
  }

  const pruned = config.dry_run ? 0 : await pruneGeneratedSearches(config.retention_days, now);
  return { libraries: libraries.length, saved, pruned, skipped: false };
}

export interface GeneratedSearchHandle {
  stop(): void;
}

/** Schedule the daily pass. Idempotent per caller; `maintenance.ts` owns the
 * single instance. The first pass runs one interval in, not at boot — a
 * process restart should not trigger a fresh round of LLM calls. */
export function startGeneratedSearch(intervalMs: number = DAY_MS): GeneratedSearchHandle {
  const timer = setInterval(() => {
    void runGeneratedSearchOnce().catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'pass failed');
    });
  }, intervalMs);
  // Don't hold the process open for a once-a-day timer.
  timer.unref?.();
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
