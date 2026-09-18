/**
 * `worker_config` — the SQLite port of the per-worker operator settings every
 * row on Settings → Workers reads and writes (#3751).
 *
 * Covers both Mongo modules that own this collection, because both own the
 * same *row*: `workers/worker-config.repo.ts` (every `runStage` stage, plus
 * the three interval workers that borrow its `paused` flag) and
 * `workers/discover/discover-config.repo.ts` (the discover sweeper, under
 * `name = 'discover'`). Splitting them again here would put two modules'
 * statements on one table, which is the thing worth avoiding: the discover
 * row and a stage row differ only in which columns they fill in.
 *
 * ## This file overlaps ticket #3748
 *
 * `worker_config` is named by both the settings slice (#3751, this work) and
 * the stage-runtime slice (#3748). It is ported here because #3751 lists it,
 * and it is kept in one module precisely so the overlap is one file to
 * reconcile rather than a statement here and a statement there. Everything
 * that touches the table goes through this module, {@link listWorkerConfigs}
 * included — that one has no counterpart in the Mongo repo because
 * `workers/routes-status.ts` opens the collection inline, and leaving it out
 * would force #3748 to write `worker_config` SQL somewhere else.
 *
 * ## What the stored row actually looks like
 *
 * `WorkerConfig` declares four non-optional fields, and the stored row
 * satisfies none of them reliably. {@link WorkerConfigRepo.patch} upserts a
 * partial, so a worker's first write can create a row holding a name and a
 * `paused` flag alone; the discover row never carries the stage fields at all.
 * Migration `0003` makes every configurable column nullable for that reason,
 * and a NULL column is read back here as an *absent* key rather than as
 * `null`, because that is what the consumers test for: `bootConfig` takes the
 * stage's own default for a field it does not find, and
 * {@link sanitizeWorkerConfig} keys its optional fields off `typeof … ===
 * 'string'`.
 *
 * MongoDB is still the live database; nothing imports this module yet. The
 * cutover (#3752) swaps the import paths.
 */

import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toBool } from './values.ts';
import type { WorkerConfig } from '../../../workers/run-stage.ts';
import {
  sanitizeWorkerConfig,
  type WorkerConfigDoc,
} from '../../../workers/worker-config-shape.ts';

export type { SqliteDb } from './db-handle.ts';

// The document shape and the wire projection are shared with the Mongo store
// rather than redeclared: both answer `/api/workers/status`, and the fields
// `sanitizeWorkerConfig` omits are the part that is actually on the wire.
export { sanitizeWorkerConfig, type WorkerConfigDoc };

/** The discover sweeper's two knobs. */
export interface DiscoverConfig {
  paused: boolean;
  sweepDirIntervalMs: number;
}

const DISCOVER_DEFAULTS: DiscoverConfig = { paused: false, sweepDirIntervalMs: 250 };
const DISCOVER_NAME = 'discover';

/** Every column, in one place, so the two read paths cannot select different sets. */
const COLUMNS =
  'name, concurrency, max_attempts, paused, pause_reason, last_seen_target_version, ' +
  'version, prompt_text, ai_provider, ai_model, sweep_dir_interval_ms';

interface WorkerConfigRow {
  name: string;
  concurrency: number | null;
  max_attempts: number | null;
  paused: number | null;
  pause_reason: string | null;
  last_seen_target_version: number | null;
  version: string | null;
  prompt_text: string | null;
  ai_provider: string | null;
  ai_model: string | null;
  sweep_dir_interval_ms: number | null;
}

/**
 * Which column carries which document field, and how to read it back.
 *
 * A table rather than nine ternaries, so the row → document mapping is one
 * branch — "is this column NULL" — applied uniformly instead of restated per
 * field.
 */
const DOC_FIELDS: ReadonlyArray<{
  column: Exclude<keyof WorkerConfigRow, 'name'>;
  key: keyof WorkerConfig;
  read?: (value: never) => unknown;
}> = [
  { column: 'concurrency', key: 'concurrency' },
  { column: 'max_attempts', key: 'maxAttempts' },
  { column: 'paused', key: 'paused', read: (value: number) => toBool(value) },
  { column: 'pause_reason', key: 'pause_reason' },
  { column: 'last_seen_target_version', key: 'last_seen_target_version' },
  { column: 'version', key: 'version' },
  { column: 'prompt_text', key: 'prompt_text' },
  { column: 'ai_provider', key: 'ai_provider' },
  { column: 'ai_model', key: 'ai_model' },
];

/**
 * A row as the document it replaces: a NULL column becomes an absent key, not
 * a `null` value.
 *
 * The cast is the honest place for the gap between the type and the data.
 * `WorkerConfigDoc` inherits four non-optional fields from `WorkerConfig`,
 * which describe a config after `bootConfig` has merged defaults into it —
 * never a guarantee the collection made, and never one this table makes
 * either. The Mongo document this replaces had exactly the same fields
 * missing at runtime.
 */
function toDoc(row: WorkerConfigRow): WorkerConfigDoc {
  const present = DOC_FIELDS.flatMap(({ column, key, read }) => {
    const value = row[column];
    return value === null
      ? []
      : [[key, read === undefined ? value : read(value as never)] as const];
  });
  return { name: row.name, ...Object.fromEntries(present) } as WorkerConfigDoc;
}

/**
 * Column name for each `WorkerConfig` key a write may carry.
 *
 * A `Map` rather than an object literal because the keys iterated into this
 * lookup come from `Object.entries` over a request body, and an object literal
 * answers `constructor` and `toString` from its prototype. Those answers are
 * truthy and are not column names, so they survive the `undefined` filter below
 * and get interpolated into the statement's column list — a syntax error at
 * best, and a shape nothing should have to reason about at worst. A `Map`
 * answers only what was put in it, so the question does not arise.
 */
const COLUMN_OF = new Map<string, string>([
  ['concurrency', 'concurrency'],
  ['maxAttempts', 'max_attempts'],
  ['paused', 'paused'],
  ['pause_reason', 'pause_reason'],
  ['last_seen_target_version', 'last_seen_target_version'],
  ['version', 'version'],
  ['prompt_text', 'prompt_text'],
  ['ai_provider', 'ai_provider'],
  ['ai_model', 'ai_model'],
  ['sweepDirIntervalMs', 'sweep_dir_interval_ms'],
]);

/**
 * What a write may carry: any subset of a stage's config, any subset of the
 * discover worker's, or — as `patch` builds it — a mixture with an explicit
 * `pause_reason: null`. Both kinds of caller write the same row.
 */
type WritableFields = Readonly<Partial<WorkerConfig & DiscoverConfig>>;

/**
 * Write the named fields onto a row, creating it when it does not exist.
 *
 * This is `$set` with `upsert` and `$setOnInsert: { name }`, statement for
 * statement: columns the caller did not name keep whatever they held, and on
 * an insert they take their NULL default — which is how a `{ paused }` patch
 * from a worker that has never booted leaves `concurrency` genuinely unset
 * rather than guessing a number for it. `name` needs no `$setOnInsert`
 * equivalent because it is the key the conflict is detected on.
 *
 * `undefined` values are dropped rather than written as NULL, matching the way
 * every caller assembles its update out of spread optionals.
 */
async function writeFields(
  name: string,
  fields: WritableFields,
  dbOverride?: SqliteDb,
): Promise<void> {
  const named = Object.entries(fields).flatMap(([key, value]) => {
    const column = COLUMN_OF.get(key);
    if (column === undefined || value === undefined) return [];
    return [{ column, value: typeof value === 'boolean' ? (value ? 1 : 0) : value }];
  });

  // A write that names no field does nothing, rather than inserting a row
  // holding only a name. `updateOne` with an empty `$set` is rejected by the
  // driver, so no call site produces one and nothing should start now.
  if (named.length === 0) return;

  const columns = named.map((field) => field.column);
  const placeholders = columns.map(() => '?').join(', ');
  const assignments = columns.map((column) => `${column} = excluded.${column}`).join(', ');
  await sqliteDb(dbOverride).write(
    `INSERT INTO worker_config (name, ${columns.join(', ')}) VALUES (?, ${placeholders})
     ON CONFLICT (name) DO UPDATE SET ${assignments}`,
    [name, ...named.map((field) => field.value)],
  );
}

/**
 * Read, upsert and patch one worker's configuration.
 *
 * Config changes are not propagated from here. `PATCH /api/workers/:name/config`
 * writes through this repo and then calls `stageRegistry.notifyConfigChanged(name)`
 * (`workers/registry.ts`), which re-reads inside the running poll loop — same
 * process, no IPC.
 *
 * The Mongo class took the collection it worked on; this one takes the tests'
 * optional handle, and production constructs it with no argument at all.
 */
export class WorkerConfigRepo {
  constructor(private readonly dbOverride?: SqliteDb) {}

  /** Load a single worker's config. Returns null when no row exists yet. */
  async load(name: string): Promise<WorkerConfig | null> {
    const doc = await readDoc(name, this.dbOverride);
    return doc === null ? null : sanitizeWorkerConfig(doc);
  }

  /** Upsert a worker's config, leaving columns the config does not carry alone. */
  async upsert(name: string, config: WorkerConfig): Promise<void> {
    await writeFields(name, config, this.dbOverride);
  }

  /**
   * Patch only the supplied fields, creating the row when it does not exist
   * yet so a write that lands before first boot is not silently lost.
   *
   * Resuming (`paused: false`) also clears `pause_reason`: the reason
   * describes the pause it arrived with, and every resume path — the button,
   * `PATCH /config`, the in-process registry — goes through here, so none of
   * them can leave a stale explanation on a running worker. A worker that
   * pauses itself again writes a fresh reason alongside its `paused: true`.
   */
  async patch(name: string, partial: Partial<WorkerConfig>): Promise<void> {
    const fields = partial.paused === false ? { ...partial, pause_reason: null } : partial;
    await writeFields(name, fields, this.dbOverride);
  }
}

/** One row as its document, or null. Shared by the class and the free reads. */
async function readDoc(name: string, dbOverride?: SqliteDb): Promise<WorkerConfigDoc | null> {
  const rows = await sqliteDb(dbOverride).read<WorkerConfigRow>(
    `SELECT ${COLUMNS} FROM worker_config WHERE name = ?`,
    [name],
  );
  const row = rows[0];
  return row === undefined ? null : toDoc(row);
}

/**
 * A worker's config, or null when the row is missing *or* the database is
 * unreachable — a worker boots with its built-in defaults either way rather
 * than failing to start.
 */
export async function loadWorkerConfigSafe(
  workerName: string,
  dbOverride?: SqliteDb,
): Promise<WorkerConfig | null> {
  try {
    return await new WorkerConfigRepo(dbOverride).load(workerName);
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[${workerName} worker] Failed to load worker config from database:`, err);
    }
    return null;
  }
}

/**
 * Every row, for the status surface that renders one line per worker.
 *
 * `workers/routes-status.ts` reads the whole collection this way and sanitizes
 * each document before exposing it. It has no function in the Mongo repo to
 * mirror — it opens the collection inline — so this is the one addition to the
 * ported surface, made here rather than in `routes-status.ts` so every
 * statement against this table stays in one module.
 */
export async function listWorkerConfigs(dbOverride?: SqliteDb): Promise<WorkerConfigDoc[]> {
  const rows = await sqliteDb(dbOverride).read<WorkerConfigRow>(
    `SELECT ${COLUMNS} FROM worker_config`,
  );
  return rows.map(toDoc);
}

/**
 * The discover sweeper's config, defaults filled in.
 *
 * Reads the same row a stage would, and answers from defaults for the two
 * fields it cares about when the row — or the column — has never been
 * written. `WorkerConfigRepo.load` cannot serve this: it projects the stage
 * fields, and `sweepDirIntervalMs` is not one of them.
 */
export async function loadDiscoverConfig(dbOverride?: SqliteDb): Promise<DiscoverConfig> {
  type DiscoverRow = Pick<WorkerConfigRow, 'paused' | 'sweep_dir_interval_ms'>;
  const rows = await sqliteDb(dbOverride).read<DiscoverRow>(
    `SELECT paused, sweep_dir_interval_ms FROM worker_config WHERE name = ?`,
    [DISCOVER_NAME],
  );
  const paused = rows[0]?.paused ?? null;
  return {
    paused: paused === null ? DISCOVER_DEFAULTS.paused : toBool(paused),
    sweepDirIntervalMs: rows[0]?.sweep_dir_interval_ms ?? DISCOVER_DEFAULTS.sweepDirIntervalMs,
  };
}

/** Write one or both discover knobs, creating the row when it does not exist. */
export async function patchDiscoverConfig(
  patch: Partial<DiscoverConfig>,
  dbOverride?: SqliteDb,
): Promise<void> {
  await writeFields(DISCOVER_NAME, patch, dbOverride);
}
