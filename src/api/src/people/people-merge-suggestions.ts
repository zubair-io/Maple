/**
 * Pure core for person-page merge suggestions: given every live person's
 * L2-normalised centroid, find each person's single best-scoring OTHER
 * person by cosine similarity. Extracted as pure math (no Mongo) so it's
 * independently unit-testable — mirrors the `cluster-embeddings.ts` split.
 *
 * Stricter than clustering's face-to-cluster threshold
 * (`DEFAULT_SIMILARITY_THRESHOLD` = 0.5 in `cluster-embeddings.ts`): merging
 * two whole people is a more consequential, harder-to-cleanly-undo action
 * than assigning one face to a cluster, so a false-positive suggestion is
 * more disruptive than a false-positive face assignment.
 */

import { dotProduct } from './cluster-embeddings.ts';

/** Empirically-chosen starting point — ratchet like
 * `DEFAULT_SIMILARITY_THRESHOLD` once real score distributions are observed
 * in production libraries. */
export const MERGE_SUGGESTION_THRESHOLD = 0.65;

export interface SuggestionCandidate {
  personIdHex: string;
  /** L2-normalised — cosine similarity is then a dot product. */
  centroid: Float32Array;
  hidden: boolean;
}

export interface MergeSuggestion {
  personIdHex: string;
  suggestedPersonIdHex: string;
  score: number;
}

/** "idAHex:idBHex" with the two ids in ascending lexicographic order, so a
 * lookup for the pair (A, B) is direction-independent regardless of which
 * side initiated a dismiss. The single source of this format — both the
 * compute pass and the dismiss action import it rather than reimplementing
 * the ordering. */
export function sortedPairKey(aHex: string, bHex: string): string {
  return aHex < bHex ? `${aHex}:${bHex}` : `${bHex}:${aHex}`;
}

interface BestMatch {
  other: SuggestionCandidate | null;
  score: number;
}

/** Best-scoring OTHER visible person for `person`, ties breaking toward the
 * first-encountered candidate (strict `>`, matching `clusterEmbeddings`'s
 * own tie-break rule) — deterministic given a stable input order. */
function bestMatchFor(
  person: SuggestionCandidate,
  visible: SuggestionCandidate[],
  dismissedPairs: ReadonlySet<string>,
): BestMatch {
  return visible.reduce<BestMatch>(
    (best, other) => {
      if (other.personIdHex === person.personIdHex) return best;
      if (dismissedPairs.has(sortedPairKey(person.personIdHex, other.personIdHex))) return best;
      const score = dotProduct(person.centroid, other.centroid);
      return score > best.score ? { other, score } : best;
    },
    { other: null, score: -Infinity },
  );
}

/**
 * All-pairs cosine similarity over people (not faces — a few hundred/
 * thousand rows, cheap compared to the face-level clustering pass). For
 * each non-hidden person, keep their single best-scoring OTHER non-hidden
 * person if it clears `threshold` and isn't in `dismissedPairs`. People
 * with no qualifying match are simply absent from the result — the caller
 * writes `null` for them.
 */
export function computeMergeSuggestions(
  people: SuggestionCandidate[],
  dismissedPairs: ReadonlySet<string>,
  threshold: number = MERGE_SUGGESTION_THRESHOLD,
): MergeSuggestion[] {
  const visible = people.filter((p) => !p.hidden);
  return visible
    .map((person) => {
      const { other, score } = bestMatchFor(person, visible, dismissedPairs);
      return other && score >= threshold
        ? { personIdHex: person.personIdHex, suggestedPersonIdHex: other.personIdHex, score }
        : null;
    })
    .filter((s): s is MergeSuggestion => s !== null);
}
