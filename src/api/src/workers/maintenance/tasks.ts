/**
 * Every library-wide maintenance job the worker tier runs on a schedule. Each
 * task says how often it should run and whether its schedule is paused, both
 * read from the database, and how to run one pass. The maintenance lane turns
 * this list into Temporal Schedules (`lane.ts`).
 *
 * A schedule is paused exactly when a pass would do nothing because of
 * configuration. A task whose paused pass still does useful work — the reaper
 * still recovers re-found files, generated-search still prunes — keeps its
 * schedule running and its own gate inside the pass.
 */

import { loadDbBackupSettings } from '../../cloudflare/backup-retain-config.ts';
import { runDbBackupPass } from '../../cloudflare/db-backup.ts';
import { maintainBackup } from '../../cloud-backup/runtime.ts';
import { isMirroringActive } from '../../fs/mirror-registry.ts';
import { runAuthExpiryPass } from '../../runtime/auth-expiry-sweep.ts';
import { loadChangeLogGcConfig } from '../change-log-gc-config.repo.ts';
import { runChangeLogGcOnce } from '../change-log-gc.ts';
import { deDuplicatePaused, runDeDuplicatePass } from '../dedupe.ts';
import { loadDerivativeAuditConfig } from '../derivative-audit/config.repo.ts';
import { derivativeAuditEveryMs, runDerivativeAuditPass } from '../derivative-audit/scan.ts';
import { generatedSearchTick } from '../generated-search/schedule.ts';
import { migrationHasWork, runMigrationPass } from '../migration.ts';
import { runMirrorCopyOnce } from '../mirror/copy.ts';
import { runMirrorScanOnce } from '../mirror/scan.ts';
import { runMissingReaperPass } from '../missing-reaper.ts';
import { drainTrashPurgeCleanup, runTrashGcOnce } from '../trash-gc.ts';
import type { MaintenanceRunOptions } from './workflow.ts';

export interface DesiredSchedule {
  everyMs: number;
  paused: boolean;
}

export interface MaintenanceTask {
  id: string;
  desired: () => Promise<DesiredSchedule>;
  run: (signal: AbortSignal, options: MaintenanceRunOptions) => Promise<void>;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const always = (everyMs: number) => async (): Promise<DesiredSchedule> => ({
  everyMs,
  paused: false,
});

const unless =
  (everyMs: number, idle: () => boolean | Promise<boolean>) =>
  async (): Promise<DesiredSchedule> => ({ everyMs, paused: await idle() });

const mirroringIdle = (): boolean => !isMirroringActive();

export const MAINTENANCE_TASKS: readonly MaintenanceTask[] = [
  {
    id: 'trash-gc',
    desired: always(DAY_MS),
    run: async () => {
      await runTrashGcOnce();
    },
  },
  {
    id: 'trash-cleanup',
    desired: always(MINUTE_MS),
    run: () => drainTrashPurgeCleanup(),
  },
  {
    id: 'change-log-gc',
    desired: unless(DAY_MS, async () => !(await loadChangeLogGcConfig()).enabled),
    run: async (signal) => {
      await runChangeLogGcOnce({ shouldStop: () => signal.aborted });
    },
  },
  {
    id: 'missing-reaper',
    desired: always(MINUTE_MS),
    run: () => runMissingReaperPass(),
  },
  {
    id: 'deduplicate',
    desired: unless(5 * MINUTE_MS, deDuplicatePaused),
    run: () => runDeDuplicatePass(),
  },
  {
    id: 'migration',
    desired: unless(5_000, async () => !(await migrationHasWork())),
    run: () => runMigrationPass(),
  },
  {
    id: 'mirror-scan',
    desired: unless(HOUR_MS, mirroringIdle),
    run: async () => {
      await runMirrorScanOnce();
    },
  },
  {
    id: 'mirror-copy',
    desired: unless(30_000, mirroringIdle),
    run: async () => {
      if (isMirroringActive()) await runMirrorCopyOnce();
    },
  },
  {
    id: 'derivative-audit',
    desired: async () => {
      const cfg = await loadDerivativeAuditConfig();
      return { everyMs: derivativeAuditEveryMs(cfg), paused: !cfg.enabled };
    },
    run: () => runDerivativeAuditPass(),
  },
  {
    id: 'generated-search',
    desired: always(15 * MINUTE_MS),
    run: async () => {
      await generatedSearchTick();
    },
  },
  {
    id: 'cloud-backup',
    desired: always(MINUTE_MS),
    run: (signal) => maintainBackup(signal),
  },
  {
    id: 'auth-expiry',
    desired: always(MINUTE_MS),
    run: () => runAuthExpiryPass(),
  },
  {
    id: 'db-backup',
    desired: unless(MINUTE_MS, async () => !(await loadDbBackupSettings()).policy.enabled),
    run: (signal, options) => runDbBackupPass(signal, options),
  },
];
