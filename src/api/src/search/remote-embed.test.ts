/**
 * The `embed` stage reaches the bundled bge-m3 in the API's search child (#5445): a request out
 * over the supervisor's IPC channel, the API's pool answers, the reply finds its request. Wired
 * here with the two sides joined directly, the way the channel joins them in production.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  answerRemoteEmbed,
  MAX_REMOTE_EMBED_TEXTS,
  remoteDocumentEmbedder,
} from './remote-embed.ts';
import type { EmbedOutcome } from './search-protocol.ts';
import {
  embedDocuments,
  chunkByCost,
  setDocumentEmbedder,
} from '../workers/embed/bundled-embedder.ts';

afterEach(() => setDocumentEmbedder(null));

const unit = (axis: number) => Float32Array.from({ length: 1024 }, (_, i) => (i === axis ? 1 : 0));

/** A worker-side bridge whose requests the API side answers from `engine`. */
function joined(engine: { embed(texts: readonly string[]): Promise<EmbedOutcome> } | null) {
  const asked: string[][] = [];
  const bridge = remoteDocumentEmbedder((request) => {
    asked.push(request.texts);
    answerRemoteEmbed({ postMessage: (reply) => bridge.receive(reply) }, request, engine);
  });
  return { bridge, asked };
}

describe('the remote document embedder', () => {
  it("returns the API child's vectors bit for bit, in order", async () => {
    const { bridge, asked } = joined({
      embed: async (texts) => ({ ok: true, vectors: texts.map((_, index) => unit(index)) }),
    });

    const outcome = await bridge.embed(['harbour', 'kitchen']);

    expect(asked).toEqual([['harbour', 'kitchen']]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.vectors).toEqual([unit(0), unit(1)]);
  });

  it('waits when the API runs no search engine, the reply is late or the channel is gone', async () => {
    expect(await joined(null).bridge.embed(['a'])).toMatchObject({ ok: false, waiting: true });
    expect(await remoteDocumentEmbedder(() => {}, 20).embed(['a'])).toMatchObject({
      ok: false,
      waiting: true,
    });
    const closed = remoteDocumentEmbedder(() => {
      throw new Error('channel closed');
    });
    expect(await closed.embed(['a'])).toEqual({
      ok: false,
      waiting: true,
      error: 'channel closed',
    });
  });

  it('passes an engine failure through as a failure', async () => {
    const { bridge } = joined({
      embed: async () => ({ ok: false, waiting: false, error: 'tokenizer failed' }),
    });
    expect(await bridge.embed(['a'])).toEqual({
      ok: false,
      waiting: false,
      error: 'tokenizer failed',
    });
  });

  it('refuses an oversized request without reaching the engine', async () => {
    const reached: number[] = [];
    const { bridge } = joined({
      embed: async (texts) => {
        reached.push(texts.length);
        return { ok: true, vectors: [] };
      },
    });
    const outcome = await bridge.embed(
      Array.from({ length: MAX_REMOTE_EMBED_TEXTS + 1 }, () => 'x'),
    );
    expect(outcome).toMatchObject({ ok: false, waiting: false });
    expect(reached).toEqual([]);
  });

  it('ignores messages that are not embed requests', () => {
    expect(answerRemoteEmbed({ postMessage: () => {} }, { type: 'search-rank', id: 1 }, null)).toBe(
      false,
    );
  });
});

describe('embedDocuments', () => {
  it('waits when this process has no channel to the engine', async () => {
    expect(await embedDocuments(['a'])).toMatchObject({ ok: false, waiting: true });
  });

  it('cuts a batch into chunks of bounded text and runs them one at a time, in order', async () => {
    const calls: string[][] = [];
    let running = 0;
    setDocumentEmbedder(async (texts) => {
      running++;
      expect(running).toBe(1);
      calls.push([...texts]);
      await Bun.sleep(5);
      running--;
      return { ok: true, vectors: texts.map((text) => unit(text.length % 1024)) };
    });
    const long = 'x'.repeat(6_000);

    const [first, second] = await Promise.all([
      embedDocuments(['a', long, 'bb']),
      embedDocuments(['ccc']),
    ]);

    expect(calls.map((chunk) => chunk.map((text) => text.length))).toEqual([
      [1],
      [6_000],
      [2],
      [3],
    ]);
    expect(first.ok && first.vectors.map((vector) => vector.indexOf(1))).toEqual([
      1,
      6_000 % 1024,
      2,
    ]);
    expect(second.ok && second.vectors.map((vector) => vector.indexOf(1))).toEqual([3]);
  });

  it('stops at the first chunk the engine cannot embed', async () => {
    const calls: number[] = [];
    setDocumentEmbedder(async (texts) => {
      calls.push(texts.length);
      return { ok: false, waiting: true, error: 'the search engine is still loading' };
    });
    expect(await embedDocuments(['x'.repeat(4_000), 'y'.repeat(4_000)])).toMatchObject({
      waiting: true,
    });
    expect(calls).toEqual([1]);
  });
});

describe('chunkByCost', () => {
  it('keeps consecutive texts together up to the limit and never splits one text', () => {
    expect(chunkByCost(['aa', 'bb', 'cc', 'dddddd'], 4)).toEqual([
      ['aa', 'bb'],
      ['cc'],
      ['dddddd'],
    ]);
    expect(chunkByCost([], 4)).toEqual([]);
  });

  it('prices a chunk by its longest text, since every text is padded to it', () => {
    const transcript = 'x'.repeat(5_000);
    const captions = Array.from({ length: 7 }, (_, i) => `caption ${i}`);
    expect(chunkByCost([transcript, ...captions]).map((chunk) => chunk.length)).toEqual([1, 7]);
    expect(chunkByCost([...captions, transcript]).map((chunk) => chunk.length)).toEqual([7, 1]);
  });

  it('counts UTF-8 bytes, not characters', () => {
    expect(chunkByCost(['éé', 'a'], 4)).toEqual([['éé'], ['a']]);
  });
});
