/**
 * `worker_config` — the SQLite port of `workers/worker-config.repo.ts` and of
 * `stage-config.ts`'s `bootConfig` (#3748).
 *
 * One row per stage, the same three verbs, the same names and return types, so
 * the cutover (#3752) changes an import path and nothing else. The one
 * substitution is the optional trailing `dbOverride`, which accepts a SQLite
 * handle instead of a Mongo `Collection` — the same seam the Mongo repo already
 * had, with a different type.
 *
 * ## Columns, not a document
 *
 * The Mongo collection stores `WorkerConfig` plus a `name` key, and reads it
 * back through `sanitizeWorkerConfig`, which drops nulls so an operator pause
 * does not surface a permanent `pause_reason: null` on every row. The table
 * keeps that distinction in the same place: every optional field is a nullable
 * column, and {@link sanitizeWorkerConfig} — unchanged in behaviour — is what
 * decides whether a key appears on the object. That is why "clearing" a pause
 * reason writes `NULL` rather than dropping anything: storage always has the
 * column, and the omission happens on the way out.
 *
 * ## Why `patch` upserts
 *
 * `PATCH /api/workers/:name/config` can land before a stage has ever booted,
 * and on Mongo the patch upserts so it does not silently no-op. Here that is
 * `INSERT … ON CONFLICT DO UPDATE` over only the supplied columns, with the
 * defaults filled in on the insert branch — a row needs `concurrency` and
 * `max_attempts`, which are `NOT NULL`, and a patch that carries neither still
 * has to produce a valid row.
 */

import { assetsDb, type SqliteDb } from './db-handle.ts';

/**
 * A stage's runtime configuration. Structurally the `WorkerConfig` the stage
 * runner already consumes; redeclared here rather than imported so this module
 * has no dependency on `workers/`, which the cutover will be editing.
 */
export interface WorkerConfig {
  concurrency: number;
  maxAttempts: number;
  paused: boolean;
  /** Last targetVersion the runner saw, for the boot-time version-bump check. */
  last_seen_target_version: number;
  /** Why the stage paused ITSELF; absent for an operator pause (#3315). */
  pause_reason?: string | null;
  version?: string | null;
  prompt_text?: string | null;
  ai_provider?: string | null;
  ai_model?: string | null;
}

/** The stored row, before nulls are dropped. */
interface WorkerConfigRow {
  name: string;
  concurrency: number;
  max_attempts: number;
  paused: number;
  pause_reason: string | null;
  last_seen_target_version: number;
  version: string | null;
  prompt_text: string | null;
  ai_provider: string | null;
  ai_model: string | null;
}

const SELECT_SQL = `
  SELECT name, concurrency, max_attempts, paused, pause_reason, last_seen_target_version,
         version, prompt_text, ai_provider, ai_model
    FROM worker_config WHERE name = ?`;

const UPSERT_SQL = `
  INSERT INTO worker_config
    (name, concurrency, max_attempts, paused, pause_reason, last_seen_target_version,
     version, prompt_text, ai_provider, ai_model)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (name) DO UPDATE SET
    concurrency = excluded.concurrency,
    max_attempts = excluded.max_attempts,
    paused = excluded.paused,
    pause_reason = excluded.pause_reason,
    last_seen_target_version = excluded.last_seen_target_version,
    version = excluded.version,
    prompt_text = excluded.prompt_text,
    ai_provider = excluded.ai_provider,
    ai_model = excluded.ai_model`;

/** Columns a `patch` may address, and the `WorkerConfig` key each comes from. */
const PATCHABLE = {
  concurrency: 'concurrency',
  maxAttempts: 'max_attempts',
  paused: 'paused',
  pause_reason: 'pause_reason',
  last_seen_target_version: 'last_seen_target_version',
  version: 'version',
  prompt_text: 'prompt_text',
  ai_provider: 'ai_provider',
  ai_model: 'ai_model',
} as const satisfies Record<keyof WorkerConfig, string>;

/**
 * What a partial patch writes into the columns it was not given.
 *
 * `concurrency` and `max_attempts` are `NOT NULL`, so a patch that creates the
 * row has to put *something* in them — where the Mongo document simply leaves
 * the fields absent for `bootConfig` to fill from the stage's own defaults.
 * Zero is that "absent", and it is unambiguous rather than a convention:
 * neither value is usable at zero. A stage at `concurrency: 0` derives a batch
 * size of zero and silently claims nothing forever, and at `maxAttempts: 0`
 * every asset dead-letters on its first attempt. {@link pickConfigured} is the
 * other half — it reads zero as "nobody has chosen yet".
 */
const PATCH_INSERT_DEFAULTS = { concurrency: 0, max_attempts: 0, paused: 0 };

/**
 * Drop the optional keys that carry no value, so a config object looks the
 * same as the one the Mongo repo returns.
 *
 * Unchanged in behaviour from its Mongo twin, including the asymmetry worth
 * knowing about: `paused` is always present because it is a real boolean,
 * while `pause_reason` appears only when a stage recorded one. An operator
 * pause therefore has no `pause_reason` key at all rather than a null, which is
 * what the Workers page branches on.
 */
export function sanitizeWorkerConfig(row: WorkerConfigRow): WorkerConfig {
  return {
    concurrency: row.concurrency,
    maxAttempts: row.max_attempts,
    paused: row.paused === 1,
    last_seen_target_version: row.last_seen_target_version,
    ...(typeof row.pause_reason === 'string' ? { pause_reason: row.pause_reason } : {}),
    ...(typeof row.version === 'string' ? { version: row.version } : {}),
    ...(typeof row.prompt_text === 'string' ? { prompt_text: row.prompt_text } : {}),
    ...(typeof row.ai_provider === 'string' ? { ai_provider: row.ai_provider } : {}),
    ...(typeof row.ai_model === 'string' ? { ai_model: row.ai_model } : {}),
  };
}

/** The bound value for one column of a `patch`. SQLite has no boolean type. */
function patchValue(key: keyof WorkerConfig, value: unknown): string | number | null {
  if (key === 'paused') return value === true ? 1 : 0;
  if (value === undefined || value === null) return null;
  return value as string | number;
}

export class WorkerConfigRepo {
  constructor(private readonly db: SqliteDb = assetsDb()) {}

  /** One stage's config, or null when it has never been seeded. */
  async load(name: string): Promise<WorkerConfig | null> {
    const rows = await this.db.read<WorkerConfigRow>(SELECT_SQL, [name]);
    const row = rows[0];
    return row === undefined ? null : sanitizeWorkerConfig(row);
  }

  /** Insert or replace a stage's config wholesale. */
  async upsert(name: string, config: WorkerConfig): Promise<void> {
    await this.db.write(UPSERT_SQL, [
      name,
      config.concurrency,
      config.maxAttempts,
      config.paused ? 1 : 0,
      config.pause_reason ?? null,
      config.last_seen_target_version,
      config.version ?? null,
      config.prompt_text ?? null,
      config.ai_provider ?? null,
      config.ai_model ?? null,
    ]);
  }

  /**
   * Update only the supplied fields, creating the row when it does not exist
   * yet so a patch that lands before first boot is not silently lost.
   *
   * Resuming (`paused: false`) also clears `pause_reason`: the reason describes
   * the pause it came with, and every resume path — the button, `PATCH
   * /config`, the in-process registry — goes through here, so none of them can
   * leave a stale explanation on a running stage.
   */
  async patch(name: string, partial: Partial<WorkerConfig>): Promise<void> {
    const fields = partial.paused === false ? { ...partial, pause_reason: null } : partial;
    const columns = (Object.keys(fields) as Array<keyof WorkerConfig>).filter(
      (key) => key in PATCHABLE,
    );
    if (columns.length === 0) return;

    const assignments = columns.map((key) => `${PATCHABLE[key]} = excluded.${PATCHABLE[key]}`);
    const inserted = { ...PATCH_INSERT_DEFAULTS } as Record<string, string | number | null>;
    for (const key of columns) inserted[PATCHABLE[key]] = patchValue(key, fields[key]);
    const insertColumns = Object.keys(inserted);

    await this.db.write(
      `INSERT INTO worker_config (name, ${insertColumns.join(', ')})
       VALUES (?, ${insertColumns.map(() => '?').join(', ')})
       ON CONFLICT (name) DO UPDATE SET ${assignments.join(', ')}`,
      [name, ...insertColumns.map((column) => inserted[column] ?? null)],
    );
  }
}

/**
 * One stage's config, or null when the database is unreachable — the
 * best-effort read the stages that consult config outside the runner use.
 */
export async function loadWorkerConfigSafe(
  workerName: string,
  dbOverride?: SqliteDb,
): Promise<WorkerConfig | null> {
  try {
    return await new WorkerConfigRepo(assetsDb(dbOverride)).load(workerName);
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[${workerName} worker] Failed to load worker config from database:`, err);
    }
    return null;
  }
}

/** The defaults half of a stage's definition, as `bootConfig` reads it. */
export interface StageDefaults extends WorkerConfig {
  /**
   * Initial paused state when no row exists yet. On later boots the saved
   * value wins.
   *
   * This is the guard against a version-gated stage marking every asset
   * permanently handled before it can do the work: a stage whose external
   * configuration may be absent — an API key, a self-hosted service URL —
   * starts paused, and a paused stage never claims, so it never reaches the
   * return path that sets `version` to target. `geocode` is the existing
   * caller.
   */
  pausedOnFirstBoot: boolean;
}

/** A stored integer, or the fallback when the column was never written. */
function pickInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

/**
 * A stored count an operator actually chose, or the stage's default.
 *
 * Zero means "not configured" for the two `NOT NULL` counts — see
 * {@link PATCH_INSERT_DEFAULTS}. This is the repair path the Mongo `bootConfig`
 * gets for free by finding the field missing, and it is not hypothetical: a row
 * whose `concurrency` is not a usable integer reaches the claim as a
 * non-integer batch size, which crashes the tick rather than reading as a
 * misconfiguration.
 */
function pickConfigured(value: unknown, fallback: number): number {
  const chosen = pickInt(value, 0);
  return chosen > 0 ? chosen : fallback;
}

/**
 * Seed-or-load a stage's config on boot.
 *
 * Idempotent: on first boot it writes the defaults, and on later boots it
 * either no-ops or repairs a row whose integer fields a `PATCH` created before
 * the stage had ever booted. That repair is not hypothetical — a row missing
 * `concurrency` reaches the claim as a non-integer batch size, which is a crash
 * rather than a misconfiguration.
 */
export async function bootConfig(
  stage: { name: string; defaults: StageDefaults },
  dbOverride?: SqliteDb,
): Promise<WorkerConfig> {
  const repo = new WorkerConfigRepo(assetsDb(dbOverride));
  const existing = await repo.load(stage.name);

  const merged: WorkerConfig = {
    ...existing,
    concurrency: pickConfigured(existing?.concurrency, stage.defaults.concurrency),
    maxAttempts: pickConfigured(existing?.maxAttempts, stage.defaults.maxAttempts),
    paused:
      typeof existing?.paused === 'boolean' ? existing.paused : stage.defaults.pausedOnFirstBoot,
    last_seen_target_version: pickInt(existing?.last_seen_target_version, 0),
    ...(typeof existing?.pause_reason === 'string' ? { pause_reason: existing.pause_reason } : {}),
  };

  await repo.upsert(stage.name, merged);
  return merged;
}
