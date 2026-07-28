/**
 * Verbatim-query contract (#2384).
 *
 * Ranking improvements for this ticket must come from document
 * representation, field weighting, blend tuning, or candidate reranking —
 * never from rewriting, expanding, paraphrasing, or injecting synonyms into
 * what the user typed. These assertions pin that: the exact submitted string
 * must reach Meilisearch unchanged, and the request body must carry no
 * query-expansion knobs.
 *
 * Scope note: `service-asset-search.ts` applies `request.query.trim()` at the
 * route boundary. That predates this work, is identity for the fixture query,
 * and is the ONLY normalisation in the path. Everything from the client
 * boundary inward — where all the ranking logic lives — is asserted here.
 */

import { describe, expect, it } from 'bun:test';
import { createMeilisearchClient } from '../src/enrichment/meilisearch-client.ts';

const FIXTURE_QUERY = 'HVAC air conditioning installation';

/** A client whose fetch records the exact JSON body sent to Meilisearch. */
function capturingClient(sink: Array<Record<string, unknown>>) {
  const fetchImpl = (async (_url: string, init?: { body?: string }) => {
    sink.push(JSON.parse(init?.body ?? '{}'));
    return new Response(JSON.stringify({ hits: [], estimatedTotalHits: 0 }), { status: 200 });
  }) as unknown as typeof fetch;
  return createMeilisearchClient({
    url: 'http://meili.test',
    semantic: true,
    embedderUrl: 'http://ollama.test',
    embedderModel: 'bge-m3',
    semanticRatio: 0.7,
    fetchImpl,
  });
}

describe('query verbatim contract (#2384)', () => {
  it('sends the submitted query byte-for-byte in hybrid mode', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await capturingClient(bodies).search(FIXTURE_QUERY, { semantic: true, limit: 20 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.q).toBe(FIXTURE_QUERY);
  });

  it('sends the submitted query byte-for-byte in lexical mode', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await capturingClient(bodies).search(FIXTURE_QUERY, { semantic: false, limit: 20 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.q).toBe(FIXTURE_QUERY);
  });

  it('adds no query-expansion knobs to the request body', () => {
    // Meilisearch applies synonyms, stop-word stripping, or a rewritten `q`
    // only if we ask for them. Asserting the exact key set means a future
    // "just add synonyms" change fails HERE instead of silently violating
    // the verbatim-query constraint.
    const bodies: Array<Record<string, unknown>> = [];
    return capturingClient(bodies)
      .search(FIXTURE_QUERY, { semantic: true, limit: 20 })
      .then(() => {
        expect(Object.keys(bodies[0]!).sort()).toEqual([
          'attributesToRetrieve',
          'filter',
          'hybrid',
          'limit',
          'offset',
          'q',
          'showRankingScore',
        ]);
      });
  });

  it('preserves case and internal spacing exactly', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const odd = 'HVAC  air Conditioning  INSTALLATION';
    await capturingClient(bodies).search(odd, { semantic: true });
    expect(bodies[0]!.q).toBe(odd);
  });

  it('does not alter a query that looks like a filename', async () => {
    // The exact-identifier path is an acceptance criterion of its own; it
    // would be defeated by any normalisation of punctuation or case.
    const bodies: Array<Record<string, unknown>> = [];
    await capturingClient(bodies).search('IMG_4185.MOV', { semantic: true });
    expect(bodies[0]!.q).toBe('IMG_4185.MOV');
  });

  it('passes a person name through untouched', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await capturingClient(bodies).search('Greyson Smith', { semantic: true });
    expect(bodies[0]!.q).toBe('Greyson Smith');
  });
});
