import { describe, expect, it } from 'bun:test';
import {
  decodeVector,
  embedTexts,
  encodeVector,
  l2Normalize,
  type FetchImpl,
} from './ollama-embed-client.ts';

const target = { url: 'http://ollama.test:11434/', model: 'bge-m3' };

function replying(
  body: unknown,
  status = 200,
): { fetchImpl: FetchImpl; calls: unknown[]; headers: unknown[] } {
  const calls: unknown[] = [];
  const headers: unknown[] = [];
  const fetchImpl: FetchImpl = async (input, init) => {
    calls.push({ input, body: JSON.parse(String(init.body)) });
    headers.push(init.headers);
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchImpl, calls, headers };
}

describe('embedTexts', () => {
  it('posts the batch with keep_alive -1 and returns unit vectors in order', async () => {
    const { fetchImpl, calls } = replying({
      embeddings: [
        [3, 4],
        [0, 2],
      ],
    });
    const vectors = await embedTexts(target, ['a', 'b'], fetchImpl);
    expect(calls).toEqual([
      {
        input: 'http://ollama.test:11434/api/embed',
        body: { model: 'bge-m3', input: ['a', 'b'], keep_alive: -1 },
      },
    ]);
    expect(Array.from(vectors[0]!)).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    expect(Array.from(vectors[1]!)).toEqual([0, 1]);
  });

  it('calls an OpenAI-compatible /embeddings with the key and restores input order', async () => {
    const { fetchImpl, calls, headers } = replying({
      data: [
        { index: 1, embedding: [0, 2] },
        { index: 0, embedding: [3, 4] },
      ],
    });
    const vectors = await embedTexts(
      { url: 'http://strata.test:8080/v1/', model: 'bge-m3', protocol: 'openai', apiKey: 'sk-s' },
      ['a', 'b'],
      fetchImpl,
    );
    expect(calls).toEqual([
      {
        input: 'http://strata.test:8080/v1/embeddings',
        body: { model: 'bge-m3', input: ['a', 'b'] },
      },
    ]);
    expect(headers).toEqual([{ 'Content-Type': 'application/json', Authorization: 'Bearer sk-s' }]);
    expect(Array.from(vectors[0]!)).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    expect(Array.from(vectors[1]!)).toEqual([0, 1]);
  });

  it('rejects an OpenAI-compatible answer without a data array', async () => {
    const { fetchImpl } = replying({ embeddings: [[1, 0]] });
    await expect(
      embedTexts({ ...target, protocol: 'openai', apiKey: 'k' }, ['a'], fetchImpl),
    ).rejects.toThrow('openai embed returned a malformed response');
  });

  it('rejects a non-OK answer', async () => {
    const { fetchImpl } = replying({}, 503);
    await expect(embedTexts(target, ['a'], fetchImpl)).rejects.toThrow('answered 503');
  });

  it('rejects a response with the wrong number of vectors', async () => {
    const { fetchImpl } = replying({ embeddings: [[1, 0]] });
    await expect(embedTexts(target, ['a', 'b'], fetchImpl)).rejects.toThrow('malformed');
  });

  it('rejects non-finite values and zero vectors', async () => {
    await expect(
      embedTexts(target, ['a'], replying({ embeddings: [['x']] }).fetchImpl),
    ).rejects.toThrow('malformed');
    await expect(
      embedTexts(target, ['a'], replying({ embeddings: [[0, 0]] }).fetchImpl),
    ).rejects.toThrow('zero vector');
  });
});

describe('vector encoding', () => {
  it('round-trips through little-endian f32 bytes', () => {
    const vector = l2Normalize([1, 2, 3, 4]);
    const bytes = encodeVector(vector);
    expect(bytes.byteLength).toBe(16);
    expect(Array.from(decodeVector(bytes))).toEqual(Array.from(vector));
  });

  it('writes 1.0 as 00 00 80 3f', () => {
    expect(Array.from(encodeVector(Float32Array.of(1)))).toEqual([0, 0, 0x80, 0x3f]);
  });
});
