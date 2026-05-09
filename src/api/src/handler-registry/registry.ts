/**
 * Stage-handler registry.
 *
 * Loads enabled rows from the `stage_handlers` Mongo collection and caches
 * them in-process. Callers go through `resolve(stage)` to learn how a stage
 * is implemented; the pipeline adapter dispatches accordingly.
 *
 * The set of handlers is small (one row per overridden stage), so we cache
 * everything on first read and bust on demand via `refresh()`. Mongo
 * unavailability is treated as "no overrides" — the pipeline falls back to
 * its in-process default. This keeps the indexer working even if the
 * handlers collection is missing or unreachable.
 */

import { stageHandlersCollection } from "../db/client.ts";
import type { StageHandlerDoc } from "../db/schema.ts";

/**
 * Pipeline stage identifiers used by the handler registry.
 * Previously imported from indexer/channel.ts (now deleted).
 */
export type Stage = "discover" | "hash" | "exif" | "thumb" | "ai" | "mongo";

export interface ResolvedHandler {
  stage: Stage;
  impl: "builtin" | "http";
  url: string | null;
  timeoutMs: number | null;
}

const BUILTIN: ResolvedHandler = {
  stage: "ai",
  impl: "builtin",
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
    case "discover":
    case "hash":
    case "exif":
    case "thumb":
    case "ai":
    case "mongo":
      return value;
    default:
      return null;
  }
}

function project(doc: StageHandlerDoc): ResolvedHandler | null {
  const stage = asStage(doc.stage);
  if (!stage) return null;
  if (doc.impl === "http") {
    if (!doc.url || typeof doc.url !== "string") return null;
    return {
      stage,
      impl: "http",
      url: doc.url,
      timeoutMs: typeof doc.timeout_ms === "number" ? doc.timeout_ms : null,
    };
  }
  return { stage, impl: "builtin", url: null, timeoutMs: null };
}

async function load(): Promise<void> {
  if (state.loaded) return;
  state.byStage.clear();
  try {
    const coll = await stageHandlersCollection();
    const rows = await coll.find({ enabled: true }).toArray();
    for (const row of rows) {
      const resolved = project(row);
      if (resolved) state.byStage.set(resolved.stage, resolved);
    }
  } catch {
    // Mongo unavailable / collection missing: leave map empty and proceed
    // with builtins. The pipeline must keep running.
  }
  state.loaded = true;
}

/**
 * Look up the active handler for a stage. Returns the builtin descriptor when
 * no enabled row matches. The first call hydrates the cache from Mongo; later
 * calls are in-process lookups until `refresh()` (or test reset) clears the
 * cache.
 */
export async function resolve(stage: Stage): Promise<ResolvedHandler> {
  await load();
  const hit = state.byStage.get(stage);
  if (hit) return hit;
  return { ...BUILTIN, stage };
}

/** Mark the cache stale so the next `resolve()` re-reads Mongo. */
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
