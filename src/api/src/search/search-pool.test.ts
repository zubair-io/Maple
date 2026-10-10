import { afterEach, expect, test } from 'bun:test';
import { QUERY_TIMEOUT_MS, type SearchChildPool } from './search-pool.ts';
import type { SearchChildConfig, SearchChildState } from './search-protocol.ts';
import { fakeChildPool } from './search.test-helpers.ts';

const CONFIG: SearchChildConfig = {
  dbPath: '/tmp/maple.sqlite',
  stateFile: '/tmp/search/state.json',
  engine: { index_dir: '/tmp/search/text' },
};

const READY: SearchChildState = { phase: 'ready', vectors: 3, texts: 3, textReady: true };
const pools: SearchChildPool[] = [];

function readyPool() {
  const { pool, children } = fakeChildPool(() => CONFIG);
  pools.push(pool);
  pool.start();
  children[0]!.reply({ type: 'state', state: READY });
  return { pool, children };
}

afterEach(() => {
  for (const pool of pools.splice(0)) pool.stop();
});

test('sends the start config, then answers nothing until the child reports ready', async () => {
  const { pool, children } = fakeChildPool(() => CONFIG);
  pools.push(pool);
  pool.start();

  expect(children[0]!.sent).toEqual([{ type: 'start', config: CONFIG }]);
  expect(pool.status().phase).toBe('starting');
  expect(await pool.search('harbour', 100)).toBeNull();
  children[0]!.reply({ type: 'state', state: READY });
  expect(pool.status()).toMatchObject({ phase: 'ready', vectors: 3, texts: 3 });
});

test('keeps one query in flight and answers each in order', async () => {
  const { pool, children } = readyPool();
  const child = children[0]!;
  const first = pool.search('harbour', 100);
  const second = pool.search('kitchen', 100);

  expect(child.queries().map((query) => query.type === 'query' && query.query)).toEqual([
    'harbour',
  ]);
  child.reply({
    type: 'query',
    id: 1,
    ok: true,
    hits: [{ id: 'a', score: 0.03, vectorRank: 1, textRank: null }],
  });
  expect(await first).toEqual([{ id: 'a', score: 0.03, vectorRank: 1, textRank: null }]);
  expect(child.queries().length).toBe(2);
  child.reply({ type: 'query', id: 2, ok: false, error: 'no query embedder' });
  expect(await second).toBeNull();
});

test('a query that waits past its deadline falls back without unblocking the next', async () => {
  const { pool, children } = readyPool();
  const stalled = pool.search('harbour', 100);
  const startedAt = Date.now();

  expect(await stalled).toBeNull();
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(QUERY_TIMEOUT_MS - 50);
  const next = pool.search('kitchen', 100);
  expect(children[0]!.queries().length).toBe(1);
  children[0]!.reply({ type: 'query', id: 1, ok: true, hits: [] });
  children[0]!.reply({ type: 'query', id: 2, ok: true, hits: [] });
  expect(await next).toEqual([]);
});

test('a crash fails the in-flight query and respawns the child', async () => {
  const { pool, children } = readyPool();
  const inFlight = pool.search('harbour', 100);
  children[0]!.crash();

  expect(await inFlight).toBeNull();
  expect(children[0]!.terminated).toBe(true);
  expect(pool.status()).toMatchObject({ phase: 'starting', restarts: 1 });
  await Bun.sleep(1_100);
  expect(children.length).toBe(2);
  expect(children[1]!.sent[0]?.type).toBe('start');
});

test('a child that cannot open its engine is reported failed and retried later', () => {
  const { pool, children } = readyPool();
  children[0]!.reply({
    type: 'state',
    state: { phase: 'failed', vectors: 0, texts: 0, textReady: false, error: 'no ORT' },
  });

  expect(pool.status()).toMatchObject({ phase: 'failed', error: 'no ORT', restarts: 1 });
  expect(children[0]!.terminated).toBe(true);
});

test('stop terminates the child and never respawns it', async () => {
  const { pool, children } = readyPool();
  pool.stop();
  children[0]!.crash();
  await Bun.sleep(1_100);

  expect(children.length).toBe(1);
  expect(pool.status().phase).toBe('stopped');
});
