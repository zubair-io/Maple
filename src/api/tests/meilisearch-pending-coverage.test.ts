/**
 * Vector-coverage markers around an unconfirmed index embedder (#4432).
 *
 * While the live Meilisearch embedder is not confirmed to match Settings — it
 * drifts, a settings task is still re-embedding, or the client was just
 * reconfigured and not checked yet — writes record `v<shape>:pending` instead
 * of Settings' fingerprint. The next confirmed-in-sync check promotes them;
 * a failed settings task leaves the old embedder live, so they stay pending.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createLiveTestDatabase, run } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import {
  commitBatch,
  type BackfillRow,
  type WriteBatch,
} from '../src/enrichment/meilisearch-backfill-compose.ts';
import {
  createMeilisearchClient,
  type MeilisearchAssetDoc,
} from '../src/enrichment/meilisearch-client.ts';
import { assetsIndexSettings } from '../src/enrichment/meilisearch-index-settings.ts';
import {
  fakeMeilisearchIndex,
  type FakeMeilisearchIndexOptions,
} from '../src/enrichment/meilisearch-test-harness.ts';
import {
  advancePendingVectorCoverage,
  countLiveAssetsWithFingerprint,
  documentShapeOf,
  syncIndexAndCoverage,
} from '../src/enrichment/meilisearch-vector-coverage.ts';
import { seedIndexableAsset } from './helpers/meili-backfill-fixtures.ts';

const OLD_OLLAMA = 'http://192.168.0.250:11434';
const NEW_OLLAMA = 'http://192.168.0.201:11434';

/** A client configured for NEW_OLLAMA against an index embedding with `live`. */
function clientAgainst(live: string, options: FakeMeilisearchIndexOptions = {}) {
  const meili = fakeMeilisearchIndex(
    assetsIndexSettings({ semantic: true, embedderUrl: live, embedderModel: 'bge-m3' }, 'caption'),
    { documents: 1_200, ...options },
  );
  return createMeilisearchClient({
    url: 'http://meili.local:7700',
    fetchImpl: meili.fetchImpl,
    taskPollIntervalMs: 0,
    semantic: true,
    embedderUrl: NEW_OLLAMA,
    embedderModel: 'bge-m3',
  });
}

function batchFor(id: string): WriteBatch {
  return {
    docs: [{ row: { id } as BackfillRow, doc: { id: 'maple-drift' } as MeilisearchAssetDoc }],
    tombstoneIds: [],
  };
}

function markerOf(db: Database, id: string): string | null {
  const row = db.query(`SELECT semantic_vector_fingerprint AS fp FROM assets WHERE id = ?`).get(id);
  return (row as { fp: string | null }).fp;
}

describe('pending vector coverage (#4432)', () => {
  it('marks a write as pending while a settings task re-embeds, then covers it on success', async () => {
    using live = await createLiveTestDatabase();
    const id = seedIndexableAsset(live.db, { mapleId: 'during-task' });
    const duringTask = clientAgainst(OLD_OLLAMA, { pendingTaskUid: 7 });
    await duringTask.ensureIndex();
    const settings = duringTask.semanticFingerprint!()!;

    await commitBatch(duringTask, batchFor(id));
    expect(markerOf(live.db, id)).toBe(`${documentShapeOf(settings)}:pending`);
    expect(await countLiveAssetsWithFingerprint(settings)).toBe(0);

    // The task succeeded: the live embedder now matches Settings.
    expect(await syncIndexAndCoverage(clientAgainst(NEW_OLLAMA))).toBe(true);
    expect(markerOf(live.db, id)).toBe(settings);
  });

  it('keeps the write uncovered when the settings task failed', async () => {
    using live = await createLiveTestDatabase();
    const id = seedIndexableAsset(live.db, { mapleId: 'failed-task' });
    const duringTask = clientAgainst(OLD_OLLAMA, { pendingTaskUid: 7 });
    await duringTask.ensureIndex();
    await commitBatch(duringTask, batchFor(id));

    // The task failed: the old embedder is still live, so nothing is confirmed.
    await syncIndexAndCoverage(clientAgainst(OLD_OLLAMA));
    expect(markerOf(live.db, id)).toMatch(/:pending$/);
    expect(await countLiveAssetsWithFingerprint(duringTask.semanticFingerprint!())).toBe(0);
  });

  it('marks a write as pending for a reconfigured client that has not been checked', async () => {
    using live = await createLiveTestDatabase();
    const id = seedIndexableAsset(live.db, { mapleId: 'reconfigured' });
    // A worker reconfigure installs a fresh client; the stage may write before
    // its first ensureIndex — even though the embedder is in fact in sync.
    const fresh = clientAgainst(NEW_OLLAMA);
    expect(fresh.embedderInSync!()).toBeNull();

    await commitBatch(fresh, batchFor(id));
    expect(markerOf(live.db, id)).toMatch(/:pending$/);

    await fresh.ensureIndex();
    await advancePendingVectorCoverage(fresh.semanticFingerprint!());
    expect(markerOf(live.db, id)).toBe(fresh.semanticFingerprint!());
  });

  it('writes the Settings fingerprint directly once the embedder is confirmed', async () => {
    using live = await createLiveTestDatabase();
    const id = seedIndexableAsset(live.db, { mapleId: 'confirmed' });
    run(live.db, `UPDATE assets SET semantic_vector_fingerprint = 'v8:old' WHERE id = ?`, id);
    const confirmed = clientAgainst(NEW_OLLAMA);
    await confirmed.ensureIndex();

    await commitBatch(confirmed, batchFor(id));
    expect(markerOf(live.db, id)).toBe(confirmed.semanticFingerprint!());
  });
});
