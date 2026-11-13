/**
 * How the `embed` stage reaches the bundled bge-m3 (#5445): the API's search child, over the bridge
 * `worker-main.ts` installs (`search/remote-embed.ts`).
 *
 * Each batch holds the child for its whole run while searches wait, so batches go one at a time
 * and are cut by cost. The tokenizer pads a batch to its longest text, so a batch costs its size
 * times its longest text, not the sum of its texts.
 */

import type { EmbedOutcome } from '../../search/search-protocol.ts';

/** `worker_config.ai_model` for this stage: what it last embedded with. */
export const BUNDLED_EMBEDDER = 'bge-m3 (bundled)';

/** `asset_vectors.endpoint` for a vector the bundled model wrote. */
export const BUNDLED_ENDPOINT = 'bundled';

/** Texts per stage batch. */
export const EMBED_BATCH = 8;

/** Texts times the longest text's UTF-8 bytes: a lone 5,000-byte transcript, or eight captions. */
const CHUNK_COST = 6_000;

export type DocumentEmbedder = (texts: readonly string[]) => Promise<EmbedOutcome>;

const state: { embedder: DocumentEmbedder | null; lane: Promise<unknown> } = {
  embedder: null,
  lane: Promise.resolve(),
};

export function setDocumentEmbedder(embedder: DocumentEmbedder | null): void {
  state.embedder = embedder;
}

/** Consecutive runs of texts whose count times longest text stays within `limit`, or one text. */
export function chunkByCost(texts: readonly string[], limit: number = CHUNK_COST): string[][] {
  return texts.reduce<{ chunks: string[][]; longest: number }>(
    ({ chunks, longest }, text) => {
      const size = Buffer.byteLength(text, 'utf-8');
      const last = chunks.at(-1);
      const widened = Math.max(longest, size);
      return last && (last.length + 1) * widened <= limit
        ? { chunks: [...chunks.slice(0, -1), [...last, text]], longest: widened }
        : { chunks: [...chunks, [text]], longest: size };
    },
    { chunks: [], longest: 0 },
  ).chunks;
}

async function embedChunks(
  embedder: DocumentEmbedder,
  chunks: readonly string[][],
): Promise<EmbedOutcome> {
  const vectors: Float32Array[] = [];
  for (const chunk of chunks) {
    const outcome = await embedder(chunk);
    if (!outcome.ok) return outcome;
    vectors.push(...outcome.vectors);
  }
  return { ok: true, vectors };
}

/** One unit vector per text, in input order, or why there are none. Batches never overlap. */
export function embedDocuments(texts: readonly string[]): Promise<EmbedOutcome> {
  const { embedder } = state;
  if (!embedder) {
    return Promise.resolve({
      ok: false,
      waiting: true,
      error: 'this process has no channel to the search engine',
    });
  }
  const run = state.lane.then(() => embedChunks(embedder, chunkByCost(texts)));
  state.lane = run.catch(() => undefined);
  return run;
}
