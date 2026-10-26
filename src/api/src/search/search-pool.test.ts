import { afterEach, expect, test } from 'bun:test';
import { QUERY_TIMEOUT_MS, type SearchChildPool } from './search-pool.ts';
import type { SearchChildConfig, SearchChildState } from './search-protocol.ts';
import { fakeChildPool } from './search.test-helpers.ts';
import { vectorToBase64 } from '../enrichment/vector-codec.ts';

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

  expect(child.queries().map((query) => query.query)).toEqual(['harbour']);
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

test('an in-flight query past its deadline restarts the wedged child and the next is served', async () => {
  const { pool, children } = readyPool();
  const startedAt = Date.now();
  const hung = pool.search('harbour', 100);
  const queued = pool.search('kitchen', 100);

  expect(await hung).toBeNull();
  expect(await queued).toBeNull();
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(QUERY_TIMEOUT_MS - 50);
  expect(children[0]!.terminated).toBe(true);
  expect(children[0]!.queries().length).toBe(1);
  expect(pool.status()).toMatchObject({ phase: 'starting', restarts: 1 });
  expect(await pool.search('lantern', 100)).toBeNull();

  await Bun.sleep(1_100);
  children[1]!.reply({ type: 'state', state: READY });
  const next = pool.search('lantern', 100);
  const [served] = children[1]!.queries();
  expect(served).toMatchObject({ query: 'lantern' });
  children[1]!.reply({ type: 'query', id: served!.id, ok: true, hits: [] });
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

test('an empty child answers no query', async () => {
  const { pool, children } = readyPool();
  children[0]!.reply({
    type: 'state',
    state: { phase: 'empty', vectors: 0, texts: 0, textReady: false },
  });
  expect(pool.status().phase).toBe('empty');
  expect(await pool.search('harbour', 100)).toBeNull();
  expect(children[0]!.queries()).toEqual([]);
  expect(children[0]!.terminated).toBe(false);
});

const unit = (axis: number) => Float32Array.from({ length: 1024 }, (_, i) => (i === axis ? 1 : 0));

test('embeds documents in an empty child, decoding the vectors in order', async () => {
  const { pool, children } = readyPool();
  children[0]!.reply({
    type: 'state',
    state: { phase: 'empty', vectors: 0, texts: 0, textReady: false },
  });
  const outcome = pool.embed(['harbour', 'kitchen']);

  expect(children[0]!.embeds()).toEqual([{ type: 'embed', id: 1, texts: ['harbour', 'kitchen'] }]);
  children[0]!.reply({
    type: 'embed',
    id: 1,
    ok: true,
    vectors: [vectorToBase64(unit(0)), vectorToBase64(unit(1))],
  });
  const result = await outcome;
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.vectors.map((vector) => vector.indexOf(1))).toEqual([0, 1]);
});

test('a waiting query goes before a waiting document batch', async () => {
  const { pool, children } = readyPool();
  const child = children[0]!;
  const firstBatch = pool.embed(['a']);
  const secondBatch = pool.embed(['b']);
  const query = pool.search('harbour', 10);

  child.reply({ type: 'embed', id: 1, ok: true, vectors: [vectorToBase64(unit(0))] });
  await firstBatch;
  expect(child.sent.at(-1)).toMatchObject({ type: 'query', query: 'harbour' });
  child.reply({ type: 'query', id: 3, ok: true, hits: [] });
  expect(await query).toEqual([]);
  expect(child.sent.at(-1)).toMatchObject({ type: 'embed', texts: ['b'] });
  child.reply({ type: 'embed', id: 2, ok: false, error: 'tokenizer failed' });
  expect(await secondBatch).toEqual({ ok: false, waiting: false, error: 'tokenizer failed' });
});

test('a loading, stopped or restarted engine asks the stage to wait', async () => {
  const { pool, children } = fakeChildPool(() => CONFIG);
  pools.push(pool);
  expect(await pool.embed(['a'])).toMatchObject({ ok: false, waiting: true });
  pool.start();
  expect(await pool.embed(['a'])).toMatchObject({
    ok: false,
    waiting: true,
    error: 'the search engine is still loading',
  });
  expect(children[0]!.embeds()).toEqual([]);

  children[0]!.reply({ type: 'state', state: READY });
  const inFlight = pool.embed(['a']);
  children[0]!.reply({
    type: 'embed',
    id: 1,
    ok: false,
    loading: true,
    error: 'search engine is not loaded',
  });
  expect(await inFlight).toMatchObject({ ok: false, waiting: true });

  const abandoned = pool.embed(['b']);
  children[0]!.crash();
  expect(await abandoned).toEqual({
    ok: false,
    waiting: true,
    error: 'the search engine restarted',
  });
});
