/**
 * The three-phase generated-search loop.
 *
 *   1. Propose — the model emits a theme and a query. No title.
 *   2. Execute — the worker runs that query through the same `buildFilter`
 *      as `/api/search`, and takes the result count plus a sample of the
 *      captions that came back.
 *   3. Title — the model names the collection from those captions.
 *
 * Phase 3 exists because a title written before the query runs can
 * misrepresent it, and no volume check catches that: observed live, a model
 * titled a collection "every year's favorite moments" over a query pinned to
 * a single year. Plenty of results, passes every gate, still false. Naming
 * the collection after what it contains makes that failure unreachable
 * instead of merely unlikely.
 *
 * Ollama and the search executor are injected. That keeps the whole loop
 * testable without a network or a database, and it is what lets the
 * dry-run path reuse this code unchanged.
 *
 * A run that ends with fewer collections than requested is a legitimate
 * outcome, surfaced on the settings page. Padding the set with collections
 * that missed the floor would be worse than showing three instead of four.
 */

import { child as childLogger } from '../../log.ts';
import {
  buildProposalPrompt,
  buildTitlePrompt,
  proposalSchema,
  TITLE_SCHEMA,
  type ProposalMiss,
} from './prompt.ts';
import type { PromptDigest } from './prompt.ts';
import { validateProposal, type ValidationContext, type GeneratedQuery } from './validate.ts';
import { toSearchQuery } from './execute.ts';
import type { GeneratedSearchInput } from './repo.ts';
import type { SearchQuery } from '../../routes/search/query.ts';

const log = childLogger('generated-search');

/** What running one candidate query yielded. */
export interface SearchOutcome {
  count: number;
  /** Sample of captions from the matched assets — phase 3's evidence. */
  captions: string[];
  coverAssetId: string | null;
}

export interface LoopDeps {
  /** Ollama call, grammar-constrained by `schema`. */
  generateJson: (prompt: string, schema: unknown) => Promise<unknown>;
  runSearch: (query: SearchQuery) => Promise<SearchOutcome>;
  digest: PromptDigest;
  validationContext: ValidationContext;
  libraryId: string;
  /** Local day this run targets, `YYYY-MM-DD`. */
  generatedFor: string;
  /** ISO write time. */
  generatedAt: string;
  model: string;
  /** How many collections to aim for. */
  count: number;
  /** Fewest results a collection may have and still be kept. */
  minResults: number;
  /** How many proposal rounds before giving up. */
  maxRounds: number;
}

/** Why a candidate was discarded, fed back to the model next round. */
interface Miss {
  theme: string;
  reason: string;
}

/** Compact query rendering for the retry feedback. */
function querySummary(query: GeneratedQuery): string {
  const parts: string[] = [];
  if (query.placeQuery !== undefined) parts.push(`"${query.placeQuery}"`);
  if (query.from !== undefined || query.to !== undefined) {
    parts.push(`${query.from ?? '…'} – ${query.to ?? '…'}`);
  }
  if (query.month !== undefined) parts.push(`month ${query.month}`);
  if (query.sceneType !== undefined) parts.push(query.sceneType);
  if (query.people !== undefined) parts.push(query.people);
  return parts.join(', ');
}

/** A validated candidate: the model's theme plus the query it proposed. */
interface Candidate {
  theme: string;
  query: GeneratedQuery;
}

/** Phase 1 for one round. Returns validated candidates; a round that returns
 * junk yields none rather than throwing — the caller simply retries. */
function readProposals(
  payload: unknown,
  ctx: ValidationContext,
): { accepted: Candidate[]; misses: Miss[] } {
  const accepted: Candidate[] = [];
  const misses: Miss[] = [];

  const collections =
    typeof payload === 'object' && payload !== null
      ? (payload as { collections?: unknown }).collections
      : undefined;
  if (!Array.isArray(collections)) return { accepted, misses };

  for (const raw of collections) {
    const result = validateProposal(raw, ctx);
    if (result.ok) {
      accepted.push({ theme: result.value.theme, query: result.value.query });
      continue;
    }
    const named =
      typeof raw === 'object' && raw !== null ? (raw as { theme?: unknown }).theme : undefined;
    misses.push({
      theme: typeof named === 'string' ? named : 'unnamed',
      reason: result.reason,
    });
  }
  return { accepted, misses };
}

/**
 * Phases 2 and 3 for one candidate: run its query, apply the floor, and title
 * it from the captions that came back. A floor miss is returned as data — it
 * becomes the next round's feedback rather than a silent drop.
 */
interface MeasureOutcome {
  collection?: GeneratedSearchInput;
  floorMiss?: ProposalMiss;
}

async function measureAndTitle(
  deps: LoopDeps,
  candidate: Candidate,
  round: number,
): Promise<MeasureOutcome> {
  const outcome = await deps
    .runSearch(toSearchQuery(candidate.query, deps.libraryId))
    .catch((err: unknown) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), theme: candidate.theme },
        'candidate search failed',
      );
      return undefined;
    });
  if (outcome === undefined) return {};

  if (outcome.count < deps.minResults) {
    log.info(
      { theme: candidate.theme, count: outcome.count, floor: deps.minResults },
      'candidate under result floor',
    );
    // Returned as data, not silently dropped: this becomes the next round's
    // feedback, so the model learns the range was empty instead of guessing
    // another doomed window.
    return {
      floorMiss: {
        theme: candidate.theme,
        count: outcome.count,
        querySummary: querySummary(candidate.query),
      },
    };
  }

  const titled = await deps
    .generateJson(buildTitlePrompt(candidate.theme, outcome.captions), TITLE_SCHEMA)
    .catch(() => undefined);
  const title = readTitle(titled);
  if (title === undefined) {
    // A collection with no title is not shippable, so it is dropped rather
    // than given a placeholder name.
    log.warn({ theme: candidate.theme }, 'titling failed; dropping candidate');
    return {};
  }

  return {
    collection: {
      library_id: deps.libraryId,
      generated_for: deps.generatedFor,
      generated_at: deps.generatedAt,
      model: deps.model,
      attempts: round,
      theme: candidate.theme,
      title: title.title,
      subtitle: title.subtitle,
      query: candidate.query,
      result_count: outcome.count,
      cover_asset_id: outcome.coverAssetId,
    },
  };
}

/** Phase 1 for one round, tolerating a call that fails outright. */
async function proposeRound(
  deps: LoopDeps,
  wanted: number,
  round: number,
  priorMisses: readonly ProposalMiss[],
): Promise<Candidate[]> {
  const payload = await deps
    .generateJson(
      buildProposalPrompt(deps.digest, wanted, priorMisses, deps.minResults),
      proposalSchema(wanted),
    )
    .catch((err: unknown) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), round },
        'proposal call failed',
      );
      return undefined;
    });
  if (payload === undefined) return [];

  const { accepted, misses } = readProposals(payload, deps.validationContext);
  for (const miss of misses) {
    log.info({ round, theme: miss.theme, reason: miss.reason }, 'proposal rejected');
  }
  return accepted;
}

/** One round's propose → measure → keep pass. Appends survivors to `saved`
 * and returns the round's floor misses — next round's feedback. */
async function runRound(
  deps: LoopDeps,
  round: number,
  saved: GeneratedSearchInput[],
  usedThemes: Set<string>,
  priorMisses: readonly ProposalMiss[],
): Promise<ProposalMiss[]> {
  const roundMisses: ProposalMiss[] = [];
  const wanted = deps.count - saved.length;
  for (const candidate of await proposeRound(deps, wanted, round, priorMisses)) {
    if (saved.length >= deps.count) break;
    // Dedupe against themes already kept — a retry round re-proposing a
    // theme that already succeeded would spend a slot on a duplicate.
    if (usedThemes.has(candidate.theme)) continue;

    const outcome = await measureAndTitle(deps, candidate, round);
    if (outcome.collection === undefined) {
      if (outcome.floorMiss !== undefined) roundMisses.push(outcome.floorMiss);
      continue;
    }

    usedThemes.add(candidate.theme);
    saved.push(outcome.collection);
  }
  return roundMisses;
}

export async function runProposalLoop(deps: LoopDeps): Promise<GeneratedSearchInput[]> {
  const saved: GeneratedSearchInput[] = [];
  const usedThemes = new Set<string>();
  // Measured failures from the previous round. Without this the retry is a
  // blind re-ask and the model can guess another doomed date window — it
  // has no way to know a range is empty; only running the query knows.
  let floorMisses: ProposalMiss[] = [];

  for (let round = 1; round <= deps.maxRounds && saved.length < deps.count; round++) {
    floorMisses = await runRound(deps, round, saved, usedThemes, floorMisses);
  }
  return saved;
}

/** Phase 3 output, or undefined when the model returned something unusable.
 * A collection with no title is not shippable, so it is dropped rather than
 * given a placeholder name. */
function readTitle(payload: unknown): { title: string; subtitle: string | null } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as { title?: unknown; subtitle?: unknown };
  if (typeof record.title !== 'string' || record.title.trim().length === 0) return undefined;
  const subtitle =
    typeof record.subtitle === 'string' && record.subtitle.trim().length > 0
      ? record.subtitle.trim()
      : null;
  return { title: record.title.trim(), subtitle };
}
