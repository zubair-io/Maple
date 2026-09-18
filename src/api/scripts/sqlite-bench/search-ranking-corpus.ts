/**
 * A tiny corpus with the ranking signal built in, for the half of the relevance
 * comparison the generated library cannot answer.
 *
 * The benchmark generator draws every blob from the same fifteen-word bag, so
 * on a broad query several thousand documents have near-identical term
 * frequencies and the top ten is a tie broken arbitrarily. Comparing two
 * engines' arbitrary tie-breaks measures nothing. These twelve documents vary
 * the two things any ranking function is supposed to weigh — how often a term
 * appears, and how long the document is — far enough apart that the correct
 * order is not a matter of opinion.
 *
 * Both BM25 (SQLite) and MongoDB's text score are term-frequency times an
 * inverse-document-frequency weight, normalised by document length. So both
 * should rank a short document that says "harbour" five times above a long one
 * that says it once, and both should put a document containing two query terms
 * above one containing either alone. Where they agree, the swap is safe; where
 * they disagree, the disagreement is a real difference in the formulas rather
 * than noise, and it is worth seeing.
 */

/** One document, with the term frequencies that decide where it should rank. */
export interface RankingDocument {
  id: string;
  /** What the document says. */
  blob: string;
  /** Why it is here, in the report. */
  shape: string;
}

/** `word` repeated `count` times, padded to `length` words with filler. */
function document(word: string, count: number, length: number, filler = 'pier'): string {
  const terms = Array.from({ length: count }, () => word);
  const padding = Array.from({ length: Math.max(0, length - count) }, () => filler);
  return [...terms, ...padding].join(' ');
}

/**
 * Twelve documents whose ranking is decided by term frequency and length, plus
 * three that answer a two-term query and three that match nothing.
 *
 * Ids are the 24-character hex the schema requires, chosen so they sort in an
 * order *unrelated* to the ranking — an engine that fell back to insertion or
 * id order would score zero here rather than accidentally look correct.
 */
export const RANKING_CORPUS: RankingDocument[] = [
  {
    id: '0000000000000000000000f1',
    blob: document('harbour', 8, 12),
    shape: 'harbour ×8, 12 words',
  },
  {
    id: '0000000000000000000000a2',
    blob: document('harbour', 8, 120),
    shape: 'harbour ×8, 120 words',
  },
  {
    id: '0000000000000000000000e3',
    blob: document('harbour', 3, 12),
    shape: 'harbour ×3, 12 words',
  },
  {
    id: '0000000000000000000000b4',
    blob: document('harbour', 3, 120),
    shape: 'harbour ×3, 120 words',
  },
  {
    id: '0000000000000000000000d5',
    blob: document('harbour', 1, 12),
    shape: 'harbour ×1, 12 words',
  },
  {
    id: '0000000000000000000000c6',
    blob: document('harbour', 1, 120),
    shape: 'harbour ×1, 120 words',
  },
  {
    id: '00000000000000000000009a',
    blob: `${document('harbour', 2, 6)} ${document('lantern', 2, 6)}`,
    shape: 'harbour ×2 + lantern ×2, 12 words',
  },
  {
    id: '00000000000000000000008b',
    blob: `${document('lantern', 4, 12)}`,
    shape: 'lantern ×4, 12 words',
  },
  {
    id: '00000000000000000000007c',
    blob: `${document('harbour', 1, 6)} ${document('lantern', 1, 6)}`,
    shape: 'harbour ×1 + lantern ×1, 12 words',
  },
  {
    id: '00000000000000000000006d',
    blob: document('pier', 12, 12, 'jetty'),
    shape: 'no query term',
  },
  {
    id: '00000000000000000000005e',
    blob: document('jetty', 12, 12, 'pier'),
    shape: 'no query term',
  },
  {
    id: '00000000000000000000004f',
    blob: document('slipway', 12, 12, 'pier'),
    shape: 'no query term',
  },
];

/**
 * The queries this corpus exists to rank.
 *
 * `acceptableTop` is a *set*, not a single right answer, and that is the point.
 * BM25 and MongoDB's text score are both term-frequency × inverse-document-
 * frequency over document length, but they weigh the two normalisations
 * differently, so on a two-term query one can legitimately lead with the
 * document carrying both terms and the other with the document carrying more of
 * the rarer term. Declaring one of those a regression would be asserting a
 * preference as a fact. What the report checks is that each engine's best match
 * is defensible, and how far down the two orderings agree.
 */
export interface RankingProbe {
  query: string;
  /** Ids that would be a defensible best match on either scoring function. */
  acceptableTop: string[];
  why: string;
}

export const RANKING_PROBES: RankingProbe[] = [
  {
    query: 'harbour',
    // One term, so there is no IDF to trade off: the most occurrences in the
    // fewest words wins on any reasonable formula.
    acceptableTop: ['0000000000000000000000f1'],
    why: 'most occurrences in the fewest words',
  },
  {
    query: 'harbour lantern',
    // Either the document with both terms, or the one with four of the rarer
    // of the two. Both are standard answers; the engines disagree about which.
    acceptableTop: ['00000000000000000000009a', '00000000000000000000008b'],
    why: 'both terms, or more of the rarer term',
  },
];

/** How far two orderings agree, counted from the top: 3 means the first three match. */
export function agreementPrefix(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < limit && a[shared] === b[shared]) shared += 1;
  return shared;
}
