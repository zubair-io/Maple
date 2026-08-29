/**
 * Keep the describe stage's dispatch fan-out equal to the total capacity of
 * its configured servers.
 *
 * Describe is the one stage whose concurrency is not an independent knob:
 * each server carries its own concurrency (Settings → Workers → Describe),
 * and the pool in `describe-server-pool.ts` enforces those per-server
 * limits. The stage-level number only decides how many claimed assets are
 * dispatched at once, so anything other than the sum is a bug — too high
 * and assets hold a lease queued for admission, too low and servers idle
 * with backlog waiting.
 *
 * Called from `applyDescribeConfig`, which runs both in the API process on
 * save and in the worker process's config-refresh loop, so the derived
 * value converges no matter which process notices the change first.
 */

import {
  DEFAULT_DESCRIBE_SERVER_CONCURRENCY,
  MAX_TOTAL_DESCRIBE_CAPACITY,
  type DescribeServerConfig,
} from '../enrichment/describe-servers.ts';
import type { ResolvedEnrichmentConfig } from '../enrichment/enrichment-config.resolve.ts';
import { getDb } from '../db/client.ts';
import { child as childLogger } from '../log.ts';
import { WorkerConfigRepo, type WorkerConfigDoc } from './worker-config.repo.ts';

const log = childLogger('describe:capacity');

export async function syncDescribeStageCapacity(rawCapacity: number): Promise<void> {
  // The write path already rejects a list over the ceiling, but the read
  // path only drops unusable ENTRIES — a hand-edited config doc can still
  // reach here with a bigger total. Clamp rather than persist a stage
  // concurrency the workers route would refuse.
  const capacity = Math.min(rawCapacity, MAX_TOTAL_DESCRIBE_CAPACITY);
  try {
    const db = await getDb();
    const repo = new WorkerConfigRepo(db.collection<WorkerConfigDoc>('worker_config'));
    const current = await repo.load('describe');
    if (current?.concurrency === capacity) return;
    await repo.patch('describe', { concurrency: capacity });
    log.info({ capacity }, 'describe stage concurrency synced to total server capacity');
  } catch (err) {
    // Best-effort: a DB hiccup here must never stop the describe config
    // from being applied. The next refresh tick retries.
    log.warn({ err }, 'failed to sync describe stage concurrency');
  }
}

/** The describe stage's saved concurrency, or `null` when no config doc
 * exists yet (fresh install). */
async function readDescribeStageConcurrency(): Promise<number | null> {
  try {
    const db = await getDb();
    const repo = new WorkerConfigRepo(db.collection<WorkerConfigDoc>('worker_config'));
    return (await repo.load('describe'))?.concurrency ?? null;
  } catch {
    return null;
  }
}

/**
 * The server list the runtime should actually use.
 *
 * When the operator has saved a list, it is authoritative — the per-server
 * numbers are theirs. When they have NOT (every deploy that predates the
 * server list, and every one that never opened the new UI), the resolver
 * derives a single server from `describe_provider_url` at a built-in
 * default concurrency — and that default must not become the deploy's new
 * throughput. An operator who had raised the describe stage to 8 would
 * otherwise find it silently running at 2 after the upgrade: the pool caps
 * in-flight calls per server, and `syncDescribeStageCapacity` would write
 * the derived total back over their setting.
 *
 * So for a derived list the single server inherits the stage's existing
 * concurrency, which makes the upgrade a no-op: one server, same number of
 * concurrent requests to the same URL as before. The operator opts into
 * per-server tuning by saving a list, at which point their numbers win.
 */
export async function describeServersForRuntime(
  cfg: ResolvedEnrichmentConfig,
  // Seam: the tests drive the derivation without a database. Production
  // callers never pass this.
  readConcurrency: () => Promise<number | null> = readDescribeStageConcurrency,
): Promise<DescribeServerConfig[]> {
  if (cfg.source.describe_servers === 'db') return cfg.describe_servers;
  const saved = await readConcurrency();
  return [
    {
      url: cfg.describe_provider_url,
      concurrency: saved ?? DEFAULT_DESCRIBE_SERVER_CONCURRENCY,
    },
  ];
}
