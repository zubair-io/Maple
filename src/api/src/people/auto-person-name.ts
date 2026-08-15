/**
 * The auto-generated cluster-name predicate, in one place.
 *
 * Online clustering names a brand-new face cluster `Person N`
 * (`clustering-job.ts`) — a placeholder the operator is expected to
 * replace, not an identity. Surfaces that present people to a human, or
 * index them for search, must exclude these: the label carries no
 * meaning, and "person" is a high-frequency token that pollutes a text
 * index.
 *
 * The pattern is ANCHORED on purpose. A `startsWith('Person ')`
 * heuristic would swallow operator-named clusters like "Person Alice";
 * the web People page documents the same rule (`people.vm.ts`
 * `AUTO_NAME_RE`).
 */

/** Matches exactly the clustering job's generated names. */
export const AUTO_PERSON_NAME = /^Person \d+$/;
