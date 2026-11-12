/**
 * The derivative-audit pass's progress, persisted. Passes run in the worker
 * tier, scheduled or requested, and `GET /api/derivative-audit/status` is
 * answered by the API process, so the summary lives in an `app_settings`
 * document both can read: written when a pass starts, at most every
 * {@link PROGRESS_SAVE_MS} while it runs, and when it ends.
 */

import { patchAppSettings, readAppSettings } from '../../db/repos/app-settings.repo.ts';
import type { DerivativeAuditSummary } from './types.ts';

const DOC_ID = 'derivative_audit_progress';

const PROGRESS_SAVE_MS = 2_000;

/**
 * A pass saves at least this often while it is going, so a summary still
 * marked running past this was left by a process that died mid-pass.
 */
const ABANDONED_AFTER_MS = 5 * 60_000;

export function emptySummary(): DerivativeAuditSummary {
  return {
    scanned: 0,
    reArmed: 0,
    byStage: {},
    skippedCooldown: 0,
    errors: 0,
    r2Deferred: 0,
    abortedReason: null,
    startedAt: null,
    finishedAt: null,
    running: false,
  };
}

interface ProgressDoc {
  summary?: DerivativeAuditSummary;
  saved_at?: string;
}

export interface SavedProgress {
  summary: DerivativeAuditSummary;
  savedAt: string | null;
}

export async function loadDerivativeAuditProgress(): Promise<SavedProgress> {
  const doc = await readAppSettings<ProgressDoc>(DOC_ID);
  return {
    summary: { ...emptySummary(), ...doc?.summary },
    savedAt: doc?.saved_at ?? null,
  };
}

export async function saveDerivativeAuditProgress(summary: DerivativeAuditSummary): Promise<void> {
  await patchAppSettings(DOC_ID, {
    summary: structuredClone(summary),
    saved_at: new Date().toISOString(),
  });
}

/** Whether a pass is going now, judged from what it last saved. */
export function passInProgress(saved: SavedProgress, now: Date = new Date()): boolean {
  if (!saved.summary.running || saved.savedAt === null) return false;
  return now.getTime() - Date.parse(saved.savedAt) < ABANDONED_AFTER_MS;
}

/** Saves `summary` if the last save was at least {@link PROGRESS_SAVE_MS} ago. */
export function throttledProgressSaver(summary: DerivativeAuditSummary): () => Promise<void> {
  const last = { at: Date.now() };
  return async () => {
    if (Date.now() - last.at < PROGRESS_SAVE_MS) return;
    last.at = Date.now();
    await saveDerivativeAuditProgress(summary);
  };
}
