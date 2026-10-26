/**
 * How the `embed` stage reaches the bundled bge-m3 (#5445): through the API's search child, over
 * the bridge `worker-main.ts` installs (`search/remote-embed.ts`).
 *
 * Batches go out one at a time and are cut to {@link CHUNK_BYTES} of text, because each one holds
 * the search child for its whole length and queries wait behind it. A typical document embeds in
 * about 50 ms on a laptop CPU, a 5,000-byte one (a long transcript) in about 800 ms.
 */

import type { EmbedOutcome } from '../../search/search-protocol.ts';

/** `worker_config.ai_model` for this stage: what it last embedded with. */
export const BUNDLED_EMBEDDER = 'bge-m3 (bundled)';

/** `asset_vectors.endpoint` for a vector the bundled model wrote. */
export const BUNDLED_ENDPOINT = 'bundled';

/** Texts per stage batch. */
export const LOCAL_EMBED_BATCH = 8;

const CHUNK_BYTES = 6_000;

export type DocumentEmbedder = (texts: readonly string[]) => Promise<EmbedOutcome>;

const state: { embedder: DocumentEmbedder | null; lane: Promise<unknown> } = {
  embedder: null,
  lane: Promise.resolve(),
};

export function setDocumentEmbedder(embedder: DocumentEmbedder | null): void {
  state.embedder = embedder;
}

/** Consecutive runs of texts, each at most {@link CHUNK_BYTES} long unless one text is longer. */
export function chunkByBytes(texts: readonly string[], limit: number = CHUNK_BYTES): string[][] {
  return texts.reduce<{ chunks: string[][]; bytes: number }>(
    ({ chunks, bytes }, text) => {
      const size = Buffer.byteLength(text, 'utf-8');
      const last = chunks.at(-1);
      return last && bytes + size <= limit
        ? { chunks: [...chunks.slice(0, -1), [...last, text]], bytes: bytes + size }
        : { chunks: [...chunks, [text]], bytes: size };
    },
    { chunks: [], bytes: 0 },
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
  const run = state.lane.then(() => embedChunks(embedder, chunkByBytes(texts)));
  state.lane = run.catch(() => undefined);
  return run;
}
