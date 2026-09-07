// The `meili` stage under Meilisearch's embedder address policy (#3315).
//
// When Meilisearch rejects the embedding server's address, a document write
// cannot succeed and each one holds Meilisearch's task queue for minutes while
// it fails on its own. The stage must not submit; it pauses itself with the
// reason and hands the asset to the runner's retry path — never to a
// `{ patch }` that would stamp the asset done with nothing indexed.
//
// Sibling to meili.test.ts (at the file-size budget).
import { afterEach, describe, expect, it } from 'bun:test';
import { ObjectId } from 'mongodb';
import type {
  MeilisearchAssetDoc,
  MeilisearchClient,
  MeilisearchSemanticStatus,
} from '../../enrichment/meilisearch-client.ts';
import {
  MeilisearchEmbedderPolicyError,
  _configureEmbeddingGateForTests,
} from '../../enrichment/meilisearch-embedding-gate.ts';
import { EMBEDDING_POLICY_KEY } from '../../enrichment/meilisearch-embedding-policy.ts';
import { _test, type ImageDoc, type StageState } from '../run-stage.ts';
import { makeConfigMock, makeImagesMock } from '../run-stage.test-helpers.ts';
import meiliStage, { meiliHandler, setMeilisearchClientForTests } from './meili.ts';

const rejected =
  'Index `assets`: While embedding documents for embedder `caption`: runtime error: could not reach embedding server: bad uri: Rejected URI';

function semanticStatus(overrides: Partial<MeilisearchSemanticStatus>): MeilisearchSemanticStatus {
  return {
    configured: true,
    enabled: true,
    embedderName: 'caption',
    model: 'bge-m3',
    semanticRatio: 0.5,
    meilisearchReachable: true,
    embedderConfigured: true,
    embedderReachable: true,
    indexedDocumentCount: 3,
    vectorizedDocumentCount: 0,
    isIndexing: false,
    error: null,
    embedderPolicyRejected: false,
    ...overrides,
  };
}

const rejectedStatus = semanticStatus({
  embedderReachable: false,
  error: rejected,
  embedderPolicyRejected: true,
});

function doneState(): StageState {
  return { version: 1, attempts: 0, last_error: null, processed_at: null, dead: false };
}

function fakeDoc(overrides: Partial<ImageDoc> = {}): ImageDoc {
  return {
    _id: new ObjectId(),
    fileinfo: [{ library_id: new ObjectId(), path: '', filename: 'test.dng', deleted_at: null }],
    ...({ maple_id: 'maple-policy-1' } as unknown as Partial<ImageDoc>),
    faces: [],
    description: 'A red bicycle',
    // Upstream stages done, so the runner's claim query hands the doc over.
    stages: { exif: doneState(), thumb: doneState() },
    ...overrides,
  } as ImageDoc;
}

function semanticClient(status: MeilisearchSemanticStatus): {
  client: MeilisearchClient;
  upserts: MeilisearchAssetDoc[];
  tombstones: string[];
} {
  const upserts: MeilisearchAssetDoc[] = [];
  const tombstones: string[] = [];
  const client: MeilisearchClient = {
    isConfigured: () => true,
    semanticConfigured: () => true,
    semanticFingerprint: () => 'fp-policy-test',
    semanticStatus: async () => status,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async (doc) => {
      upserts.push(doc);
    },
    upsertOrThrow: async (doc) => {
      upserts.push(doc);
    },
    tombstone: async (id) => {
      tombstones.push(id);
    },
    tombstoneBatchOrThrow: async (ids) => {
      tombstones.push(...ids);
    },
    search: async () => ({ ids: [], estimatedTotal: 0 }),
  };
  return { client, upserts, tombstones };
}

function recordPauses(): string[] {
  const pauses: string[] = [];
  _configureEmbeddingGateForTests({
    pauseStage: async (reason) => {
      pauses.push(reason);
    },
  });
  return pauses;
}

const fakeCtx = {} as never;

afterEach(() => {
  setMeilisearchClientForTests(null);
  _configureEmbeddingGateForTests(null);
});

describe('meiliHandler — embedder policy gate (#3315)', () => {
  it('refuses the upsert, pauses the stage with the policy reason, and throws for the retry path', async () => {
    const pauses = recordPauses();
    const { client, upserts } = semanticClient(rejectedStatus);
    setMeilisearchClientForTests(client);

    await expect(meiliHandler(fakeDoc(), fakeCtx)).rejects.toBeInstanceOf(
      MeilisearchEmbedderPolicyError,
    );

    expect(upserts).toHaveLength(0);
    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toContain(EMBEDDING_POLICY_KEY);
    expect(pauses[0]).toContain('Rejected URI');
  });

  it('refuses the tombstone for a trashed asset just the same — the template embeds those too', async () => {
    const pauses = recordPauses();
    const { client, tombstones } = semanticClient(rejectedStatus);
    setMeilisearchClientForTests(client);

    await expect(
      meiliHandler(fakeDoc({ deleted_at: '2026-09-01T00:00:00.000Z' } as never), fakeCtx),
    ).rejects.toBeInstanceOf(MeilisearchEmbedderPolicyError);

    expect(tombstones).toHaveLength(0);
    expect(pauses).toHaveLength(1);
  });

  it('indexes normally and pauses nothing when the embedder is admitted', async () => {
    const pauses = recordPauses();
    const { client, upserts } = semanticClient(semanticStatus({}));
    setMeilisearchClientForTests(client);

    const result = await meiliHandler(fakeDoc(), fakeCtx);

    expect('patch' in result).toBe(true);
    expect(upserts).toHaveLength(1);
    expect(pauses).toHaveLength(0);
  });

  it('through the runner: the asset keeps a retryable attempt and is never stamped done', async () => {
    const pauses = recordPauses();
    const { client } = semanticClient(rejectedStatus);
    setMeilisearchClientForTests(client);
    const images = makeImagesMock([fakeDoc()]);
    const config = {
      concurrency: 2,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: meiliStage.targetVersion,
    };

    await _test.runOnce(meiliStage, config, images, makeConfigMock());

    const doc = (await images.find({}).toArray())[0] as unknown as ImageDoc & {
      search_blob?: string;
    };
    const state = doc.stages?.meili;
    // Below target — a version stamp is what "done" means to the claim
    // query, and it must not appear.
    expect(state?.version ?? 0).toBeLessThan(meiliStage.targetVersion);
    expect(state?.attempts).toBe(1);
    expect(state?.dead).toBe(false);
    expect(state?.last_error).toContain(EMBEDDING_POLICY_KEY);
    // No `{ patch }` reached the doc.
    expect(doc.search_blob).toBeUndefined();
    expect(pauses).toHaveLength(1);
  });
});
