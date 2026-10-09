/**
 * Keeps the live `assets` index settings in line with Maple's (#4432).
 *
 * Attribute settings are applied automatically at boot, after a settings save
 * and on the worker's readiness retry. The `caption` embedder is not: for an
 * Ollama embedder, Meilisearch regenerates every stored embedding when the
 * `url`, `model` or `source` changes ("When modified for `ollama` and `rest`,
 * embeddings are always regenerated" —
 * https://www.meilisearch.com/docs/reference/api/settings/update-embedders),
 * which on a large library is hours of load on the embedding host. Embedder
 * drift is therefore only reported here and applied by an explicit operator
 * action — except on an index with no documents, where there is nothing to
 * re-embed.
 */

import { child as childLogger } from '../log.ts';
import {
  assetsIndexSettings,
  driftedAssetsIndexSettings,
  embedderChange,
  embedderSummary,
  type EmbedderChange,
  type EmbedderSummary,
} from './meilisearch-index-settings.ts';
import {
  isLiveConfig,
  meilisearchHttp,
  waitForMeilisearchTask,
  type MeilisearchTaskSummary,
  type MeilisearchTransportConfig,
} from './meilisearch-transport.ts';

const log = childLogger('enrichment:meilisearch');

export interface IndexSettingsSyncConfig extends MeilisearchTransportConfig {
  indexName: string;
  semantic: boolean;
  embedderUrl: string;
  embedderModel: string;
}

export interface IndexSyncResult {
  /** The live embedder matches Maple's settings and no settings task is
   * still running — vector coverage may be carried forward. */
  embedderInSync: boolean;
}

export type EmbedderDriftState = 'unconfigured' | 'unreachable' | 'pending' | 'in_sync' | 'drift';

export interface EmbedderDriftReport {
  state: EmbedderDriftState;
  configured: EmbedderSummary | null;
  live: EmbedderSummary | null;
  changedFields: string[];
  documentCount: number | null;
  reembedsAllDocuments: boolean;
}

export interface EmbedderApplyResult {
  taskUid: number | null;
  reembedsAllDocuments: boolean;
  documentCount: number | null;
}

export const UNCONFIGURED_EMBEDDER_REPORT: EmbedderDriftReport = {
  state: 'unconfigured',
  configured: null,
  live: null,
  changedFields: [],
  documentCount: null,
  reembedsAllDocuments: false,
};

interface TaskList {
  results?: Array<{ uid?: number }>;
}

interface IndexSnapshot {
  pendingTaskUid: number | null;
  settings: Record<string, unknown> | null;
  documentCount: number | null;
  expected: Record<string, unknown>;
  change: EmbedderChange | null;
}

async function pendingSettingsTaskUid(config: IndexSettingsSyncConfig): Promise<number | null> {
  const query = new URLSearchParams({
    indexUids: config.indexName,
    types: 'settingsUpdate',
    statuses: 'enqueued,processing',
    limit: '1',
  });
  const result = await meilisearchHttp<TaskList>(config, 'GET', `/tasks?${query}`);
  const uid = result.ok ? result.body?.results?.[0]?.uid : undefined;
  return Number.isInteger(uid) ? uid! : null;
}

async function documentCount(config: IndexSettingsSyncConfig): Promise<number | null> {
  const stats = await meilisearchHttp<{ numberOfDocuments?: number }>(
    config,
    'GET',
    `/indexes/${config.indexName}/stats`,
  );
  const count = stats.ok ? stats.body?.numberOfDocuments : undefined;
  return typeof count === 'number' ? count : null;
}

async function readIndexSnapshot(
  config: IndexSettingsSyncConfig,
  embedderName: string,
): Promise<IndexSnapshot> {
  const expected = assetsIndexSettings(config, embedderName);
  const [pendingTaskUid, current, count] = await Promise.all([
    pendingSettingsTaskUid(config),
    meilisearchHttp<Record<string, unknown>>(
      config,
      'GET',
      `/indexes/${config.indexName}/settings`,
    ),
    documentCount(config),
  ]);
  const settings = current.ok ? current.body : null;
  const change =
    settings === null ? null : embedderChange(settings.embedders, expected.embedders, embedderName);
  return { pendingTaskUid, settings, documentCount: count, expected, change };
}

async function patchSettings(
  config: IndexSettingsSyncConfig,
  patch: Record<string, unknown>,
  operation: string,
): Promise<MeilisearchTaskSummary> {
  const result = await meilisearchHttp<MeilisearchTaskSummary>(
    config,
    'PATCH',
    `/indexes/${config.indexName}/settings`,
    patch,
  );
  if (!result.ok) {
    log.warn({ status: result.status, err: result.errorText }, `meilisearch ${operation} failed`);
    throw new Error(`meilisearch ${operation} failed: ${result.errorText ?? result.status}`);
  }
  return result.body ?? {};
}

function embedderPatch(change: EmbedderChange, embedderName: string): Record<string, unknown> {
  return { embedders: { [embedderName]: change.patch } };
}

const warnedDrift = new Set<string>();

function warnEmbedderDrift(change: EmbedderChange, count: number | null): void {
  const details = { ...change, patch: undefined, documentCount: count };
  const key = JSON.stringify(details);
  if (warnedDrift.has(key)) return;
  warnedDrift.add(key);
  log.warn(
    details,
    'meilisearch embedder differs from Maple settings — not applied automatically; apply it ' +
      'from Settings → Workers → Meilisearch (Meilisearch re-embeds every document for an ' +
      'Ollama url/model change)',
  );
}

/** Attribute drift is PATCHed; embedder drift only on an empty index. */
function automaticPatch(snapshot: IndexSnapshot, embedderName: string): Record<string, unknown> {
  if (snapshot.settings === null) {
    const { embedders: _embedders, ...attributes } = snapshot.expected;
    return attributes;
  }
  const { embedders: _drift, ...attributes } = driftedAssetsIndexSettings(
    snapshot.settings,
    snapshot.expected,
  );
  const change = snapshot.change;
  return change !== null && snapshot.documentCount === 0
    ? { ...attributes, ...embedderPatch(change, embedderName) }
    : attributes;
}

export async function syncAssetsIndexSettings(
  config: IndexSettingsSyncConfig,
  embedderName: string,
): Promise<IndexSyncResult> {
  const snapshot = await readIndexSnapshot(config, embedderName);
  if (snapshot.pendingTaskUid !== null) {
    log.info(
      { taskUid: snapshot.pendingTaskUid },
      'meilisearch settings task still running — rechecking later',
    );
    return { embedderInSync: false };
  }
  const patch = automaticPatch(snapshot, embedderName);
  const embedderDeferred = snapshot.change !== null && !('embedders' in patch);
  if (embedderDeferred) warnEmbedderDrift(snapshot.change!, snapshot.documentCount);
  if (Object.keys(patch).length > 0) {
    const task = await patchSettings(config, patch, 'ensureIndex apply-settings');
    if (task.taskUid !== undefined) {
      await waitForMeilisearchTask(
        config,
        { ok: true, status: 202, body: task, errorText: null },
        'apply assets index settings',
      );
    }
  }
  return { embedderInSync: snapshot.settings !== null && !embedderDeferred };
}

function reportFor(snapshot: IndexSnapshot, embedderName: string): EmbedderDriftReport {
  const configured = embedderSummary(snapshot.expected.embedders, embedderName);
  const change = snapshot.change;
  const base = {
    configured,
    documentCount: snapshot.documentCount,
    live: change === null ? configured : change.live,
    changedFields: change?.changedFields ?? [],
    reembedsAllDocuments: change?.reembedsAllDocuments ?? false,
  };
  if (snapshot.settings === null) return { ...base, live: null, state: 'unreachable' };
  if (snapshot.pendingTaskUid !== null) return { ...base, state: 'pending' };
  return { ...base, state: change === null ? 'in_sync' : 'drift' };
}

/** Operator-facing comparison of the live embedder with Maple's settings. */
export async function readEmbedderDrift(
  config: IndexSettingsSyncConfig,
  embedderName: string,
): Promise<EmbedderDriftReport> {
  if (!isLiveConfig(config)) return UNCONFIGURED_EMBEDDER_REPORT;
  return reportFor(await readIndexSnapshot(config, embedderName), embedderName);
}

export class EmbedderApplyConflictError extends Error {
  constructor(readonly state: EmbedderDriftState) {
    super(`meilisearch embedder cannot be applied while ${state}`);
    this.name = 'EmbedderApplyConflictError';
  }
}

/** Enqueue the embedder change — only the drifted fields — without waiting:
 * a re-embed outlives any request. Returns the Meilisearch task uid. */
export async function applyEmbedderSettings(
  config: IndexSettingsSyncConfig,
  embedderName: string,
): Promise<EmbedderApplyResult> {
  if (!isLiveConfig(config)) throw new EmbedderApplyConflictError('unconfigured');
  const snapshot = await readIndexSnapshot(config, embedderName);
  if (snapshot.settings === null) throw new EmbedderApplyConflictError('unreachable');
  if (snapshot.pendingTaskUid !== null) throw new EmbedderApplyConflictError('pending');
  const change = snapshot.change;
  if (change === null) throw new EmbedderApplyConflictError('in_sync');
  const task = await patchSettings(config, embedderPatch(change, embedderName), 'apply embedder');
  log.warn(
    { ...change, patch: undefined, documentCount: snapshot.documentCount, taskUid: task.taskUid },
    'meilisearch embedder change applied by operator — Meilisearch is regenerating embeddings',
  );
  return {
    taskUid: task.taskUid ?? null,
    reembedsAllDocuments: change.reembedsAllDocuments,
    documentCount: snapshot.documentCount,
  };
}
