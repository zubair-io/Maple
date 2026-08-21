/**
 * The three-phase loop, with Ollama and the search executor injected so the
 * whole thing runs without a network or a database.
 *
 * Phase order is the design, not an implementation detail: propose a theme
 * and a query, RUN the query, then title the collection from the captions
 * that actually came back. A title written before the query runs can
 * misrepresent it, and no result-count check catches that — the failure looks
 * identical to success from the outside.
 */

import { describe, it, expect } from 'bun:test';
import { runProposalLoop, type LoopDeps } from './loop.ts';
import type { PromptDigest } from './prompt.ts';

const DIGEST: PromptDigest = {
  today: 'Monday, 17 August 2026',
  people: ['Zoe', 'Greyson'],
  coverageYears: [2016, 2017, 2018],
  onThisMonthByYear: [{ year: 2017, count: 315 }],
  recentThemes: [],
  semanticSearch: true,
};

/** A phase-1 payload with `n` proposals, themed `t0`, `t1`, … */
function proposals(...themes: string[]) {
  return {
    collections: themes.map((theme) => ({
      theme,
      query: {
        placeQuery: `photographs of ${theme}`,
        from: null,
        to: null,
        month: null,
        people: null,
        sceneType: null,
      },
    })),
  };
}

interface StubOptions {
  /** Successive phase-1 payloads, one per round. */
  rounds: unknown[];
  /** Result count keyed by theme; missing themes count as plentiful. */
  counts?: Record<string, number>;
}

function makeDeps(opts: StubOptions): LoopDeps & { titlePrompts: string[] } {
  const titlePrompts: string[] = [];
  let round = 0;

  return {
    titlePrompts,
    digest: DIGEST,
    validationContext: { allowedPeople: DIGEST.people, coverageYears: DIGEST.coverageYears },
    libraryId: '507f1f77bcf86cd799439011',
    generatedFor: '2026-08-17',
    generatedAt: '2026-08-17T06:00:00.000Z',
    model: 'test-model',
    count: 2,
    minResults: 8,
    maxRounds: 3,
    generateJson: async (prompt: string) => {
      // Phase 3 prompts carry caption bullets; phase 1 prompts do not.
      if (prompt.includes('descriptions of photographs it actually contains')) {
        titlePrompts.push(prompt);
        return { title: 'A Title', subtitle: 'A subtitle' };
      }
      const payload = opts.rounds[Math.min(round, opts.rounds.length - 1)];
      round += 1;
      return payload;
    },
    runSearch: async (query) => {
      const theme = (query.placeQuery ?? '').replace('photographs of ', '');
      const count = opts.counts?.[theme] ?? 42;
      return {
        count,
        captions: count > 0 ? [`a caption for ${theme}`] : [],
        coverAssetId: count > 0 ? `cover-${theme}` : null,
      };
    },
  };
}

describe('runProposalLoop — happy path', () => {
  it('returns one saved collection per proposal that clears the floor', async () => {
    const saved = await runProposalLoop(makeDeps({ rounds: [proposals('picnics', 'snow days')] }));
    expect(saved).toHaveLength(2);
    expect(saved.map((s) => s.theme).sort()).toEqual(['picnics', 'snow days']);
  });

  it('records the count and cover from the executed search, not from the model', async () => {
    const [first] = await runProposalLoop(
      makeDeps({ rounds: [proposals('picnics')], counts: { picnics: 34 } }),
    );
    expect(first.result_count).toBe(34);
    expect(first.cover_asset_id).toBe('cover-picnics');
  });

  it('titles each collection from the captions the query returned', async () => {
    const deps = makeDeps({ rounds: [proposals('picnics')] });
    const [first] = await runProposalLoop(deps);

    expect(first.title).toBe('A Title');
    expect(first.subtitle).toBe('A subtitle');
    // The proof that phase 3 saw real results rather than the original idea.
    expect(deps.titlePrompts[0]).toContain('a caption for picnics');
  });

  it('stamps provenance so a bad run can be traced to its model', async () => {
    const [first] = await runProposalLoop(makeDeps({ rounds: [proposals('picnics')] }));
    expect(first.model).toBe('test-model');
    expect(first.library_id).toBe('507f1f77bcf86cd799439011');
    expect(first.generated_for).toBe('2026-08-17');
  });
});

describe('runProposalLoop — thin results', () => {
  it('drops a proposal under the floor and keeps the retry that clears it', async () => {
    const saved = await runProposalLoop(
      makeDeps({
        rounds: [proposals('too thin'), proposals('plentiful')],
        counts: { 'too thin': 2 },
      }),
    );
    expect(saved.map((s) => s.theme)).toEqual(['plentiful']);
  });

  it('never returns a collection below the floor', async () => {
    const saved = await runProposalLoop(
      makeDeps({ rounds: [proposals('always thin')], counts: { 'always thin': 1 } }),
    );
    expect(saved).toEqual([]);
  });

  it('gives up after maxRounds and returns fewer than requested', async () => {
    // A partial day is an honest outcome, visible on the settings page —
    // better than padding the set with collections nobody wants to see.
    const saved = await runProposalLoop(
      makeDeps({
        rounds: [proposals('thin one', 'thin two')],
        counts: { 'thin one': 0, 'thin two': 1 },
      }),
    );
    expect(saved).toEqual([]);
  });
});

describe('runProposalLoop — malformed model output', () => {
  it('survives a round that is not valid at all', async () => {
    const saved = await runProposalLoop(
      makeDeps({ rounds: ['not json at all', proposals('recovered')] }),
    );
    expect(saved.map((s) => s.theme)).toEqual(['recovered']);
  });

  it('drops a proposal naming someone outside the roster', async () => {
    const withStranger = {
      collections: [
        {
          theme: 'stranger danger',
          query: {
            placeQuery: 'x',
            from: null,
            to: null,
            month: null,
            people: 'Mallory',
            sceneType: null,
          },
        },
      ],
    };
    const saved = await runProposalLoop(makeDeps({ rounds: [withStranger] }));
    expect(saved).toEqual([]);
  });
});
