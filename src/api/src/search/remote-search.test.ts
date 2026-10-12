/**
 * The worker tier ranks through the API's search child (#4510): a request out over the
 * supervisor's IPC channel, the API's child answers, the reply finds its request. Wired here
 * end to end with the two sides joined directly, the way the channel joins them in production.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { answerRemoteSearch, remoteInProcessSearch } from './remote-search.ts';
import {
  inProcessRanker,
  setInProcessSearchForTests,
  setRemoteInProcessSearch,
} from './search-pool.ts';
import { fakeInProcessSearch } from './search.test-helpers.ts';
import {
  inProcessRanking,
  resetSearchEngineSelectionForTests,
  saveSearchEngine,
} from './search-engine-selection.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { RANKED_WINDOW_MAX } from '../db/repos/search.ranked.ts';

afterEach(() => {
  setInProcessSearchForTests(null);
  setRemoteInProcessSearch(null);
  resetSearchEngineSelectionForTests();
});

/** A worker-side bridge whose requests the API side answers from its installed engine. */
function joined() {
  const bridge = remoteInProcessSearch((request) => {
    answerRemoteSearch({ postMessage: (reply) => bridge.receive(reply) }, request);
  });
  return { bridge };
}

describe('the remote search bridge', () => {
  it("answers with the API child's hits", async () => {
    const engine = fakeInProcessSearch(['a', 'b']);
    setInProcessSearchForTests(engine);
    const { bridge } = joined();

    const hits = await bridge.search('harbour', 30);

    expect(hits?.map((hit) => hit.id)).toEqual(['a', 'b']);
    expect(engine.queries).toEqual([{ query: 'harbour', k: 30 }]);
  });

  it("answers null while the API's child is not running or still loading", async () => {
    const { bridge } = joined();
    expect(await bridge.search('harbour', 30)).toBeNull();

    setInProcessSearchForTests(fakeInProcessSearch(null));
    expect(await bridge.search('harbour', 30)).toBeNull();
  });

  it('answers null when no reply comes back in time', async () => {
    const bridge = remoteInProcessSearch(() => {}, 20);
    expect(await bridge.search('harbour', 30)).toBeNull();
  });

  it('answers null when the channel is gone', async () => {
    const bridge = remoteInProcessSearch(() => {
      throw new Error('channel closed');
    });
    expect(await bridge.search('harbour', 30)).toBeNull();
  });

  it('routes each reply to its own request', async () => {
    const pending: Array<() => void> = [];
    const bridge = remoteInProcessSearch((request) => {
      pending.push(() =>
        bridge.receive({
          type: 'search-rank-reply',
          id: request.id,
          hits: [{ id: request.query, score: 1, vectorRank: 1, textRank: null }],
        }),
      );
    });
    const first = bridge.search('first', 10);
    const second = bridge.search('second', 10);
    pending.reverse().forEach((answer) => answer());

    expect((await first)?.[0]?.id).toBe('first');
    expect((await second)?.[0]?.id).toBe('second');
  });

  it('caps the depth a worker can ask the API child for', async () => {
    const engine = fakeInProcessSearch(['a']);
    setInProcessSearchForTests(engine);
    const { bridge } = joined();

    await bridge.search('harbour', 1_000_000);

    expect(engine.queries[0]!.k).toBe(RANKED_WINDOW_MAX);
  });

  it('ignores messages that are not search requests', () => {
    const posted: unknown[] = [];
    expect(answerRemoteSearch({ postMessage: (m) => posted.push(m) }, { type: 'memory' })).toBe(
      false,
    );
    expect(posted).toEqual([]);
  });

  it("ranks a worker's search through the API's child when in-process is selected", async () => {
    using _live = await createLiveTestDatabase();
    await saveSearchEngine('in-process');
    const api = fakeInProcessSearch(['remote-hit']);
    const bridge = remoteInProcessSearch((request) =>
      answerRemoteSearch({ postMessage: (reply) => bridge.receive(reply) }, request, api),
    );
    setRemoteInProcessSearch(bridge);

    expect(inProcessRanker()).toBe(bridge);
    expect((await inProcessRanking('harbour', 30))?.map((hit) => hit.id)).toEqual(['remote-hit']);
    expect(api.queries).toEqual([{ query: 'harbour', k: 30 }]);
  });
});
