/**
 * Persisted change-log-gc config. Mirrors the missing-reaper / dedupe config shape:
 * a single document in `app_settings` keyed by `_id: "change-log-gc"`.
 *
 * Primary knobs:
 * - `retention_days`: how many days of asset change history to retain (default 30).
 * - `enabled`: boolean toggle (default true).
 * - `last_run`: telemetry from the most recent sweep pass.
 *
 * DB-backed per the CLAUDE.md "configure via the settings system" rule — operator-tunable
 * from Settings → Workers, re-read each sweep tick so changes take effect without restart.
 */

import {
  patchAppSettings,
  readAppSettings,
  type SettingsValue,
} from '../db/repos/app-settings.repo.ts';
import type { SqliteDb } from '../db/repos/db-handle.ts';
import { child as childLogger } from '../log.ts';

const DOC_ID = 'change-log-gc';
const log = childLogger('change-log-gc:config');

export const DEFAULT_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650; // 10 years

export interface ChangeLogGcRunSummary {
  deleted: number;
  batches: number;
  duration_ms: number;
  pruned_through: number;
  remaining: number;
  finished_at: string;
  error?: string;
}

export interface ChangeLogGcConfig {
  enabled: boolean;
  retention_days: number;
  last_run: ChangeLogGcRunSummary | null;
}

interface ChangeLogGcDoc {
  _id: string;
  enabled?: boolean;
  retention_days?: number;
  last_run?: ChangeLogGcRunSummary | null;
}

export function clampRetentionDays(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.round(n)));
}

/** Load full config document from app_settings. */
export async function loadChangeLogGcConfig(dbOverride?: SqliteDb): Promise<ChangeLogGcConfig> {
  try {
    const doc = await readAppSettings<ChangeLogGcDoc>(DOC_ID, dbOverride);
    if (doc) {
      return {
        enabled: doc.enabled ?? true,
        retention_days:
          typeof doc.retention_days === 'number'
            ? clampRetentionDays(doc.retention_days)
            : DEFAULT_RETENTION_DAYS,
        last_run: doc.last_run ?? null,
      };
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'could not load change-log-gc config from app_settings — falling back to defaults',
    );
  }
  return {
    enabled: true,
    retention_days: DEFAULT_RETENTION_DAYS,
    last_run: null,
  };
}

/** Persist partial config patch. Returns updated config. */
export async function saveChangeLogGcConfig(
  patch: Partial<Pick<ChangeLogGcConfig, 'enabled' | 'retention_days'>>,
  dbOverride?: SqliteDb,
): Promise<ChangeLogGcConfig> {
  const setDoc: Record<string, SettingsValue | undefined> = {};
  if (typeof patch.enabled === 'boolean') {
    setDoc.enabled = patch.enabled;
  }
  if (typeof patch.retention_days === 'number') {
    setDoc.retention_days = clampRetentionDays(patch.retention_days);
  }
  await patchAppSettings(DOC_ID, setDoc, dbOverride);
  return loadChangeLogGcConfig(dbOverride);
}

/** Record summary of the latest sweep pass. */
export async function recordChangeLogGcRun(
  summary: ChangeLogGcRunSummary,
  dbOverride?: SqliteDb,
): Promise<void> {
  try {
    await patchAppSettings(DOC_ID, { last_run: summary }, dbOverride);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'failed to record change-log-gc run in app_settings',
    );
  }
}
