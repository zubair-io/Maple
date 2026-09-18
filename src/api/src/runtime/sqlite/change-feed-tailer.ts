// The polling loop, the stop/singleton bookkeeping and the republish pass are
// near-copies of the Mongo tailer's, because only the lines that reach the
// database differ between them. Factoring the shared half into a base class
// would couple the two implementations together shortly before one of them is
// deleted, which is the opposite of what this migration's beside-then-switch
// shape is for. The duplication ends with the Mongo tailer, at the cutover
// (#3752).
// fallow-ignore-file code-duplication

/**
 * ChangeFeedTailer — the SQLite port of `runtime/change-feed-tailer.ts`
 * (#3747). Bridges persisted `asset_changes` rows to the in-process ChangeBus.
 *
 * Why this exists: worker stages run in CHILD processes spawned by the
 * supervisor. When a worker calls `recordAndPublishAssetChange` the row lands in
 * the database (visible to every process) but the `getChangeBus().publish()`
 * only fires on the child's local bus — the parent API process, where SSE
 * clients are connected, never sees it. Without the tailer, every
 * worker-emitted change is invisible to the File Provider extension.
 *
 * Strategy: every `intervalMs`, read rows with `cursor > localMax` and
 * republish each via the bus's idempotent `publish()`. The bus dedupes by
 * cursor, so an event that ALSO arrived through the in-process route (an XMP
 * write from the API process itself) is not delivered twice.
 *
 * The tailer is also the source of truth for the bus's persisted high
 * watermark, which is what lets the SSE route answer 409 to a client whose
 * cursor predates a restart.
 *
 * ## The watermark is seeded from the counter, not from the journal
 *
 * This is the one behavioural difference from the Mongo tailer, and it fixes a
 * real hole. The Mongo version seeds the watermark from `highestCursor()` — the
 * largest cursor still *stored*. Retention pruning (#3741) deletes old rows by
 * design, so a swept journal reports 0, the watermark starts at 0, and
 * `ChangeBus.isCursorReplayable` then answers true for every stale cursor it is
 * asked about, because the empty-buffer branch is `since >= watermark`. A
 * client that was offline across the sweep reconnects, is told its cursor is
 * fine, and receives an open stream carrying nothing — silently missing every
 * change the sweep removed, with no 409 to send it back for a full
 * re-enumeration.
 *
 * `server_state.seq` survives pruning, because it counts what was allocated
 * rather than what is retained. Seeding from the larger of the two makes the
 * empty-journal case answer 409 exactly as the pruned-but-non-empty case
 * already did. `localMax` keeps its own meaning — the highest cursor this
 * process has republished — so it is still seeded from the journal.
 */

import { child as childLogger } from '../../log.ts';
import {
  allocatedCursor,
  highestCursor,
  listChangesSince,
  type SqliteDb,
} from '../../db/sqlite/repos/changes.repo.ts';
import { getChangeBus } from '../change-bus.ts';

const log = childLogger('change-feed-tailer-sqlite');

export interface ChangeFeedTailerOptions {
  /** Polling interval in ms. Default 500ms — keeps SSE latency under one
   * second on average without hammering the database. */
  intervalMs?: number;
  /** Max rows per tick. Caps a backlog burst so a busy worker batch doesn't
   * translate into a single giant query. Default 500, ceiling 1000 (the limit
   * `listChangesSince` clamps to). */
  batchSize?: number;
  /**
   * Database handle for tests that want an isolated database. Production omits
   * it and the process-wide pool applies — the same seam, with the same
   * default, that every ported repository function carries.
   */
  db?: SqliteDb;
}

export class ChangeFeedTailer {
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly db: SqliteDb | undefined;
  private localMax = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;

  constructor(opts: ChangeFeedTailerOptions = {}) {
    this.intervalMs = Math.max(50, opts.intervalMs ?? 500);
    this.batchSize = Math.max(1, opts.batchSize ?? 500);
    this.db = opts.db;
  }

  /**
   * Start the tailer. Initialises `localMax` from the journal's high watermark
   * so we don't re-publish historical rows on boot, sets the bus's persisted
   * high watermark from the larger of the journal and the allocation counter,
   * then schedules the polling loop.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    try {
      const [journalMax, allocated] = await Promise.all([
        highestCursor(this.db),
        allocatedCursor(this.db),
      ]);
      this.localMax = journalMax;
      getChangeBus().setPersistedHighWatermark(Math.max(journalMax, allocated));
      log.info({ localMax: journalMax, allocated }, 'tailer started');
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : err },
        'tailer boot: cursor read failed; starting from 0',
      );
      this.localMax = 0;
    }
    this.scheduleNext();
  }

  /** Stop polling. Safe to call multiple times. */
  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one tick. Public for tests — production code uses the timer. Returns
   * the number of rows republished.
   */
  async tickOnce(): Promise<number> {
    const rows = await listChangesSince(this.db, {
      since: this.localMax,
      limit: this.batchSize,
    });
    if (rows.length === 0) return 0;
    const bus = getChangeBus();
    for (const row of rows) {
      // Bus publish() is cursor-idempotent — workers that happened to share the
      // API process bus won't get their events doubled here.
      bus.publish(row);
    }
    this.localMax = rows[rows.length - 1]!.cursor;
    bus.setPersistedHighWatermark(this.localMax);
    return rows.length;
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tickOnce()
        .catch((err) => {
          log.error({ err: err instanceof Error ? err.message : err }, 'tick failed');
        })
        .finally(() => this.scheduleNext());
    }, this.intervalMs);
  }
}

// Process-wide singleton.
let _instance: ChangeFeedTailer | null = null;

export function getChangeFeedTailer(): ChangeFeedTailer {
  if (!_instance) _instance = new ChangeFeedTailer();
  return _instance;
}

/** Test helper. */
export function __resetChangeFeedTailerForTests(): void {
  if (_instance) _instance.stop();
  _instance = null;
}
