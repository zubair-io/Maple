/**
 * Stage-handler registry.
 *
 * Loads enabled rows from the `stage_handlers` table and caches them
 * in-process. Callers go through `resolve(stage)` to learn how a stage
 * is implemented; the pipeline adapter dispatches accordingly.
 *
 * The set of handlers is small (one row per overridden stage), so we cache
 * everything on first read and bust on demand via `refresh()`. A database
 * that cannot be reached is treated as "no overrides" — the pipeline falls
 * back to its in-process default. This keeps the indexer working even if the
 * table is empty or the handle is unavailable.
 */

import { listEnabledStageHandlers } from '../db/repos/stage-handlers.repo.ts';
import type { StageHandlerDoc } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('handler-registry');

/**
 * Pipeline stage identifiers used by the handler registry.
 * Previously imported from indexer/channel.ts (now deleted).
 */
export type Stage = 'discover' | 'hash' | 'exif' | 'thumb' | 'ai';

export interface ResolvedHandler {
  stage: Stage;
  impl: 'builtin' | 'http';
  url: string | null;
  timeoutMs: number | null;
}

const BUILTIN: ResolvedHandler = {
  stage: 'ai',
  impl: 'builtin',
  url: null,
  timeoutMs: null,
};

interface RegistryState {
  loaded: boolean;
  byStage: Map<Stage, ResolvedHandler>;
}

const state: RegistryState = {
  loaded: false,
  byStage: new Map(),
};

function asStage(value: unknown): Stage | null {
  switch (value) {
    case 'discover':
    case 'hash':
    case 'exif':
    case 'thumb':
    case 'ai':
      return value;
    default:
      return null;
  }
}

function project(doc: StageHandlerDoc): ResolvedHandler | null {
  const stage = asStage(doc.stage);
  if (!stage) return null;
  if (doc.impl === 'http') {
    if (!doc.url || typeof doc.url !== 'string') return null;
    return {
      stage,
      impl: 'http',
      url: doc.url,
      timeoutMs: typeof doc.timeout_ms === 'number' ? doc.timeout_ms : null,
    };
  }
  return { stage, impl: 'builtin', url: null, timeoutMs: null };
}

async function load(): Promise<void> {
  if (state.loaded) return;
  state.byStage.clear();
  try {
    for (const row of await listEnabledStageHandlers()) {
      const resolved = project(row);
      if (!resolved) {
        // A row for a stage this build no longer knows, or an `http` row with
        // no url. Dropping it is right — there is nothing to dispatch to — but
        // dropping it silently is not: retiring a name from {@link Stage}
        // (#3808 retired `mongo`) turns every persisted row carrying it into a
        // handler that stops being honoured with no trace of why.
        log.warn(
          { stage: row.stage, impl: row.impl },
          'stage_handlers row ignored — unknown stage, or an http handler with no url',
        );
        continue;
      }
      state.byStage.set(resolved.stage, resolved);
    }
  } catch {
    // Database unavailable: leave the map empty and proceed with builtins.
    // The pipeline must keep running.
  }
  state.loaded = true;
}

/**
 * Look up the active handler for a stage. Returns the builtin descriptor when
 * no enabled row matches. The first call hydrates the cache from the database;
 * later calls are in-process lookups until `refresh()` (or test reset) clears
 * the cache.
 */
export async function resolve(stage: Stage): Promise<ResolvedHandler> {
  await load();
  const hit = state.byStage.get(stage);
  if (hit) return hit;
  return { ...BUILTIN, stage };
}

/** Mark the cache stale so the next `resolve()` re-reads the table. */
export function refresh(): void {
  state.loaded = false;
  state.byStage.clear();
}

/**
 * Test hook: reset the cache. Equivalent to `refresh()` today, exposed under
 * a different name so production callers don't reach for it accidentally.
 */
export function __resetForTests(): void {
  refresh();
}
