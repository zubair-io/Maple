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
const MERGE_SUGGESTION_THRESHOLD = 0.65;

export interface SuggestionCandidate {
  personIdHex: string;
  /** L2-normalised — cosine similarity is then a dot product. */
  centroid: Float32Array;
  hidden: boolean;
}

/** How many ranked candidates to keep per person. The read side walks the
 * list and surfaces the first one that's still valid, so dismissing or
 * merging the current suggestion immediately reveals the next instead of
 * leaving the banner empty until the next clustering run. Small on purpose:
 * past a handful, a "match" this weak isn't worth showing. */
const MERGE_SUGGESTION_CANDIDATES = 5;

export interface MergeCandidate {
  suggestedPersonIdHex: string;
  score: number;
}

export interface MergeSuggestion {
  personIdHex: string;
  /** Ranked best-first. Never empty (people with no qualifying match are
   * omitted from the result entirely). */
  candidates: MergeCandidate[];
}

/** "idAHex:idBHex" with the two ids in ascending lexicographic order, so a
 * lookup for the pair (A, B) is direction-independent regardless of which
 * side initiated a dismiss. The single source of this format — both the
 * compute pass and the dismiss action import it rather than reimplementing
 * the ordering. */
export function sortedPairKey(aHex: string, bHex: string): string {
  return aHex < bHex ? `${aHex}:${bHex}` : `${bHex}:${aHex}`;
}

/** The `limit` best-scoring OTHER visible people for `person`, ranked
 * best-first. Ties break by id so the ranking is deterministic regardless
 * of input order. */
function topMatchesFor(
  person: SuggestionCandidate,
  visible: SuggestionCandidate[],
  dismissedPairs: ReadonlySet<string>,
  threshold: number,
  limit: number,
): MergeCandidate[] {
  const scored: MergeCandidate[] = [];
  for (const other of visible) {
    if (other.personIdHex === person.personIdHex) continue;
    if (dismissedPairs.has(sortedPairKey(person.personIdHex, other.personIdHex))) continue;
    const score = dotProduct(person.centroid, other.centroid);
    // Filter to the threshold BEFORE collecting: on a large library only a
    // handful of pairs qualify, so this stays a short list per person
    // rather than one entry per other person.
    if (score >= threshold) scored.push({ suggestedPersonIdHex: other.personIdHex, score });
  }
  scored.sort(
    (a, b) => b.score - a.score || a.suggestedPersonIdHex.localeCompare(b.suggestedPersonIdHex),
  );
  return scored.slice(0, limit);
}

/**
 * All-pairs cosine similarity over people (not faces — cheap compared to
 * the face-level clustering pass). For each non-hidden person, keep their
 * top `limit` other non-hidden people that clear `threshold` and aren't in
 * `dismissedPairs`, ranked best-first. People with no qualifying match are
 * simply absent from the result — the caller clears them.
 *
 * Keeping a ranked list rather than the single best match is what lets the
 * UI advance to the next candidate the moment one is dismissed or merged,
 * without re-running this pass.
 */
export function computeMergeSuggestions(
  people: SuggestionCandidate[],
  dismissedPairs: ReadonlySet<string>,
  threshold: number = MERGE_SUGGESTION_THRESHOLD,
  limit: number = MERGE_SUGGESTION_CANDIDATES,
): MergeSuggestion[] {
  const visible = people.filter((p) => !p.hidden);
  return visible
    .map((person) => {
      const candidates = topMatchesFor(person, visible, dismissedPairs, threshold, limit);
      return candidates.length > 0 ? { personIdHex: person.personIdHex, candidates } : null;
    })
    .filter((s): s is MergeSuggestion => s !== null);
}
