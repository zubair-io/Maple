import { assignedAi } from '../../enrichment/ai-connections.ts';
/**
 * Generated-search maintenance job: one pass per library per day. When a pass
 * is owed is decided by the restart-safe schedule in `schedule.ts`.
 *
 * A library-wide, timer-fired job — NOT a per-asset stage. Stages in
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
import { loadGeneratedSearchConfig, type GeneratedSearchConfig } from './config.repo.ts';
import { runProposalLoop } from './loop.ts';
import { createOllamaJsonClient } from './ollama-adapter.ts';
import { pruneGeneratedSearches, type GeneratedSearchInput } from './repo.ts';
import {
  claimLibraryRun,
  loadRunRecords,
  settleClaimedRun,
  type ClaimMode,
  type LibraryRunRecord,
  type RunTrigger,
} from './run-state.repo.ts';
import { runGeneratedSearch } from './search-adapter.ts';

const log = childLogger('generated-search');

export interface GeneratedSearchSummary {
  libraries: number;
  saved: number;
  pruned: number;
  skipped: boolean;
}

/** `YYYY-MM-DD` in UTC — the key a day's collections are grouped under. */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** One library's pass: digest, propose/measure/title. Returns the collections
 * to publish; persisting them is the claim holder's job (`settleClaimedRun`). */
async function runForLibrary(
  libraryId: string,
  ctx: {
    client: { generateJson: (prompt: string, schema: unknown) => Promise<unknown> };
    config: GeneratedSearchConfig;
    model: string;
    generatedFor: string;
    generatedAt: string;
    now: Date;
  },
): Promise<GeneratedSearchInput[]> {
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
    return [];
  }

  if (collections.length < ctx.config.collections_per_day) {
    // A partial day is legitimate, but the operator should be able to see it
    // happened rather than wonder why the widget has two cards.
    log.info(
      { libraryId, saved: collections.length, wanted: ctx.config.collections_per_day },
      'run produced fewer collections than requested',
    );
  }
  return collections;
}

type LibraryPass = (libraryId: string) => Promise<readonly GeneratedSearchInput[]>;

export interface RunOptions {
  /** Run now: bypass the pause gate. */
  force?: boolean;
  /** Only these libraries; every registered library when omitted. */
  libraries?: readonly string[];
  trigger?: RunTrigger;
  /** Stamps each run record; the schedule's tests inject theirs. */
  clock?: () => Date;
  /** The records the schedule read when it decided these libraries were owed.
   * Each claim then requires the record to be unchanged; without it (Run now)
   * a claim only has to find no live pass in flight. */
  observed?: ReadonlyMap<string, LibraryRunRecord>;
  /** Test seam replacing the digest → LLM → persist pass for one library. */
  runLibrary?: LibraryPass;
}

/** A saved AI assignment is independent; legacy deployments retain their
 * existing endpoint/model until the unified settings are first saved. */
async function resolveModelEndpoint(
  config: GeneratedSearchConfig,
): Promise<{ model: string; url: string }> {
  const enrichment = resolveEnrichmentConfig(await loadEnrichmentConfig());
  const assigned = assignedAi(enrichment.ai_connections, 'generated-search');
  const legacyModel = config.model.length > 0 ? config.model : enrichment.describe_model;
  return assigned === null
    ? { model: legacyModel, url: enrichment.describe_provider_url }
    : { model: assigned.model, url: assigned.primary.url };
}

async function realLibraryPass(config: GeneratedSearchConfig, now: Date): Promise<LibraryPass> {
  const { model, url } = await resolveModelEndpoint(config);
  const ctx = {
    client: createOllamaJsonClient(url, model),
    config,
    model,
    generatedFor: dayKey(now),
    generatedAt: now.toISOString(),
    now,
  };
  return (libraryId) => runForLibrary(libraryId, ctx);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One library's attempt, bracketed by its persisted run record: an atomic
 * `running` claim before the model is called, so a restart mid-pass or a
 * pass in the other process cannot start a second one, then a fenced publish
 * of the collections and outcome. A lost claim skips the library; a claim
 * taken over mid-pass (it ran past the stale threshold) publishes nothing.
 */
async function attemptLibrary(
  running: LibraryRunRecord,
  mode: ClaimMode,
  pass: LibraryPass,
  dryRun: boolean,
  clock: () => Date,
): Promise<number> {
  if (!(await claimLibraryRun(running, mode, clock()))) {
    log.info({ libraryId: running.library_id }, 'another pass holds the claim — skipping');
    return 0;
  }
  const settled = await pass(running.library_id).then(
    (collections) => ({ collections: dryRun ? [] : collections, error: null }),
    (err: unknown) => ({ collections: [], error: errorText(err) }),
  );
  const saved = settled.collections.length;
  if (settled.error !== null) {
    // One library's failure must not abort the others.
    log.warn({ libraryId: running.library_id, err: settled.error }, 'library pass failed');
  }
  const outcome =
    settled.error !== null ? 'failed' : dryRun ? 'dry-run' : saved > 0 ? 'saved' : 'empty';
  const held = await settleClaimedRun(
    { ...running, finished_at: clock().toISOString(), outcome, saved, error: settled.error },
    settled.collections,
  );
  if (!held) {
    log.warn({ libraryId: running.library_id }, 'claim was taken over mid-pass — discarding');
    return 0;
  }
  return saved;
}

/**
 * One pass over every library, or the given subset. The schedule calls it for
 * the libraries it finds owed today; Run now calls it for all of them.
 */
export async function runGeneratedSearchOnce(
  now: Date = new Date(),
  opts: RunOptions = {},
): Promise<GeneratedSearchSummary> {
  const config = await loadGeneratedSearchConfig();
  // `force` is the operator's Run-now: it bypasses the pause gate so a
  // just-enabled worker (or a dry run while still paused) fires immediately
  // instead of waiting for the schedule.
  if (config.paused && !opts.force) {
    // Paused stops the LLM run, not retention. A worker paused for months
    // must not let generated_searches outlive its window unbounded.
    const pruned = await pruneGeneratedSearches(config.retention_days, now);
    return { libraries: 0, saved: 0, pruned, skipped: true };
  }

  const pass = opts.runLibrary ?? (await realLibraryPass(config, now));
  const libraries = opts.libraries ?? [...(await loadLibraryRoots()).keys()];
  const clock = opts.clock ?? (() => new Date());
  const day = dayKey(now);
  const records = opts.observed ?? (await loadRunRecords());
  const claimMode = (libraryId: string): ClaimMode =>
    opts.observed === undefined
      ? { force: true }
      : { force: false, expectedStartedAt: opts.observed.get(libraryId)?.started_at ?? null };
  const attemptsToday = (libraryId: string): number => {
    const record = records.get(libraryId);
    return record?.day === day ? record.attempts : 0;
  };
  let saved = 0;
  for (const libraryId of libraries) {
    saved += await attemptLibrary(
      {
        library_id: libraryId,
        claim_id: crypto.randomUUID(),
        day,
        attempts: attemptsToday(libraryId) + 1,
        started_at: clock().toISOString(),
        finished_at: null,
        outcome: 'running',
        saved: 0,
        error: null,
        trigger: opts.trigger ?? 'run-now',
      },
      claimMode(libraryId),
      pass,
      config.dry_run,
      clock,
    );
  }

  const pruned = config.dry_run ? 0 : await pruneGeneratedSearches(config.retention_days, now);
  return { libraries: libraries.length, saved, pruned, skipped: false };
}
