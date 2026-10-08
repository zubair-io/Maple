import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as configRepo from './enrichment-config.repo.ts';
import { initializeHttpSearch } from './meilisearch-http-bootstrap.ts';
import {
  createMeilisearchClient,
  meilisearchClient,
  setMeilisearchClientForTests,
} from './meilisearch-client.ts';
import { assetsIndexSettings } from './meilisearch-index-settings.ts';
import { EmbedderApplyConflictError } from './meilisearch-settings-sync.ts';
import {
  fakeMeilisearchIndex,
  type FakeMeilisearchIndex,
  type FakeMeilisearchIndexOptions,
} from './meilisearch-test-harness.ts';
import { otelLogStream } from '../otel-logs.ts';

const MEILI = 'http://meili.local:7700';
const OLD_OLLAMA = 'http://192.168.0.250:11434';
const NEW_OLLAMA = 'http://192.168.0.201:11434';
const API_KEY = 'meili-master-key-never-logged';
const LIBRARY = 335_000;

function liveSettings(embedderUrl: string, embedderModel = 'bge-m3'): Record<string, unknown> {
  return assetsIndexSettings({ semantic: true, embedderUrl, embedderModel }, 'caption');
}

function index(
  embedderUrl: string,
  options: FakeMeilisearchIndexOptions = { documents: LIBRARY },
  embedderModel = 'bge-m3',
): FakeMeilisearchIndex {
  return fakeMeilisearchIndex(liveSettings(embedderUrl, embedderModel), options);
}

function client(meili: FakeMeilisearchIndex, embedderUrl: string, embedderModel = 'bge-m3') {
  return createMeilisearchClient({
    url: MEILI,
    apiKey: API_KEY,
    fetchImpl: meili.fetchImpl,
    taskPollIntervalMs: 0,
    taskTimeoutMs: 1000,
    semantic: true,
    embedderUrl,
    embedderModel,
  });
}

function captureLogs(): { records: Array<Record<string, unknown>>; restore: () => void } {
  const records: Array<Record<string, unknown>> = [];
  const spy = spyOn(otelLogStream, 'write').mockImplementation((line: string) => {
    try {
      records.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // non-JSON line
    }
  });
  return { records, restore: () => spy.mockRestore() };
}

async function withLogs(work: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const logs = captureLogs();
  try {
    await work();
  } finally {
    logs.restore();
  }
  return logs.records;
}

describe('Meilisearch embedder drift at boot and on save (#4432)', () => {
  it('warns about a url drift on a populated index but never PATCHes the embedder', async () => {
    const meili = index(OLD_OLLAMA);
    const meiliClient = client(meili, NEW_OLLAMA);
    const records = await withLogs(() => meiliClient.ensureIndex());

    expect(meili.patches).toHaveLength(0);
    expect(meiliClient.embedderInSync?.()).toBe(false);
    const warning = records.find((r) => r.changedFields !== undefined);
    expect(warning?.level).toBe(40);
    expect(warning?.changedFields).toEqual(['url']);
    expect(warning?.reembedsAllDocuments).toBe(true);
    expect(warning?.documentCount).toBe(LIBRARY);
    expect(warning?.live).toEqual({ url: `${OLD_OLLAMA}/api/embed`, model: 'bge-m3' });
    expect(warning?.configured).toEqual({ url: `${NEW_OLLAMA}/api/embed`, model: 'bge-m3' });
    expect(JSON.stringify(records)).not.toContain(API_KEY);
  });

  it('reports the drift for the settings page', async () => {
    const report = await client(index(OLD_OLLAMA), NEW_OLLAMA).embedderDrift!();
    expect(report).toEqual({
      state: 'drift',
      configured: { url: `${NEW_OLLAMA}/api/embed`, model: 'bge-m3' },
      live: { url: `${OLD_OLLAMA}/api/embed`, model: 'bge-m3' },
      changedFields: ['url'],
      documentCount: LIBRARY,
      reembedsAllDocuments: true,
    });
  });

  it('does nothing when the live embedder matches', async () => {
    const meili = index(NEW_OLLAMA);
    const meiliClient = client(meili, NEW_OLLAMA);
    const records = await withLogs(() => meiliClient.ensureIndex());
    expect(meili.patches).toHaveLength(0);
    expect(meiliClient.embedderInSync?.()).toBe(true);
    expect(records.some((r) => r.changedFields !== undefined)).toBe(false);
    expect((await meiliClient.embedderDrift!()).state).toBe('in_sync');
  });

  it('does not remove a populated index embedder when semantic search reads as off', async () => {
    // A config row that fails to load resolves semantic search to its default
    // (off); auto-removing the embedder then would throw away every vector.
    const meili = index(OLD_OLLAMA);
    await createMeilisearchClient({
      url: MEILI,
      fetchImpl: meili.fetchImpl,
      taskPollIntervalMs: 0,
      semantic: false,
    }).ensureIndex();
    expect(meili.patches).toHaveLength(0);
  });

  it('registers the embedder automatically on an empty index', async () => {
    const meili = fakeMeilisearchIndex({}, { documents: 0 });
    const meiliClient = client(meili, NEW_OLLAMA);
    await meiliClient.ensureIndex();
    expect(meili.patches).toHaveLength(1);
    const caption = (meili.patches[0]!.embedders as Record<string, Record<string, unknown>>)
      .caption!;
    expect(caption.url).toBe(`${NEW_OLLAMA}/api/embed`);
    expect(meiliClient.embedderInSync?.()).toBe(true);
  });

  it('leaves the index alone while a settings task is still running', async () => {
    const meili = index(OLD_OLLAMA, { documents: LIBRARY, pendingTaskUid: 7 });
    const meiliClient = client(meili, NEW_OLLAMA);
    await meiliClient.ensureIndex();
    expect(meili.patches).toHaveLength(0);
    expect(meiliClient.embedderInSync?.()).toBe(false);
    expect((await meiliClient.embedderDrift!()).state).toBe('pending');
    await expect(meiliClient.applyEmbedderSettings!()).rejects.toBeInstanceOf(
      EmbedderApplyConflictError,
    );
  });
});

describe('explicit embedder apply (#4432)', () => {
  it('sends exactly one PATCH carrying only the changed url', async () => {
    const meili = index(OLD_OLLAMA);
    const meiliClient = client(meili, NEW_OLLAMA);
    const result = await meiliClient.applyEmbedderSettings!();

    expect(meili.patches).toEqual([{ embedders: { caption: { url: `${NEW_OLLAMA}/api/embed` } } }]);
    expect(result).toEqual({ taskUid: 41, reembedsAllDocuments: true, documentCount: LIBRARY });
    await meiliClient.ensureIndex();
    expect(meiliClient.embedderInSync?.()).toBe(true);
    expect(meili.patches).toHaveLength(1);
  });

  it('sends the model and its dimensions on a model change', async () => {
    const meili = index(NEW_OLLAMA, { documents: LIBRARY }, 'nomic-embed-text');
    const meiliClient = client(meili, NEW_OLLAMA, 'bge-m3');
    const report = await meiliClient.embedderDrift!();
    expect(report.changedFields).toEqual(['model', 'dimensions']);
    expect(report.reembedsAllDocuments).toBe(true);

    await meiliClient.applyEmbedderSettings!();
    expect(meili.patches).toEqual([
      { embedders: { caption: { model: 'bge-m3', dimensions: 1024 } } },
    ]);
  });

  it('resets stale dimensions when switching to a model of unknown size', async () => {
    const meili = index(NEW_OLLAMA);
    await client(meili, NEW_OLLAMA, 'private-embedder').applyEmbedderSettings!();
    expect(meili.patches).toEqual([
      { embedders: { caption: { model: 'private-embedder', dimensions: null } } },
    ]);
  });

  it('refuses when nothing differs', async () => {
    const meili = index(NEW_OLLAMA);
    await expect(client(meili, NEW_OLLAMA).applyEmbedderSettings!()).rejects.toBeInstanceOf(
      EmbedderApplyConflictError,
    );
    expect(meili.patches).toHaveLength(0);
  });
});

describe('Meilisearch failures never break boot (#4432)', () => {
  afterEach(() => setMeilisearchClientForTests(null));

  it('reports an unreachable index instead of throwing', async () => {
    const meili = index(OLD_OLLAMA, { failSettings: true });
    expect((await client(meili, NEW_OLLAMA).embedderDrift!()).state).toBe('unreachable');
  });

  it('logs a warning, resolves, and leaves search on Meilisearch', async () => {
    const meili = fakeMeilisearchIndex({}, { failSettings: true, documents: LIBRARY });
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(meili.fetchImpl);
    const loadSpy = spyOn(configRepo, 'loadEnrichmentConfig').mockImplementation(async () => ({
      nominatim_url: null,
      geocode_worker_enabled: false,
      meilisearch_url: MEILI,
      meilisearch_api_key: API_KEY,
    }));
    try {
      const records = await withLogs(() => initializeHttpSearch());
      const warning = records.find(
        (r) => r.level === 40 && String(r.msg).includes('Meilisearch setup did not complete'),
      );
      expect(warning).toBeDefined();
      expect(JSON.stringify(records)).not.toContain(API_KEY);

      const shared = meilisearchClient();
      expect(shared.isConfigured()).toBe(true);
      expect((await shared.search('lake')).ids).toEqual(['a1']);
    } finally {
      loadSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});
