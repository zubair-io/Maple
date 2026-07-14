# Person page: suggest a likely duplicate to merge

Date: 2026-07-14
Status: Approved design — ready for implementation plan

## Summary

Proactively suggest a likely-duplicate person to merge, instead of requiring the
operator to recognize the duplicate themselves in the existing "Merge into…"
name picker. Every person already carries a `centroid` (mean face embedding,
refreshed by the clustering job) — this is the same signal clustering uses to
decide "same person," reused here at the person-to-person level instead of the
face-to-person level.

Primary scenario: **post-clustering triage**. Auto-clustering often splits one
real person across several auto-named `Person N` rows (different angle/
lighting pushed a face just past the similarity threshold into a new cluster).
The suggestion helps an operator spot and consolidate these before naming.

- **Detail page** (`/settings/people/:id`): a banner shows the best-matching
  other person (name, avatar, match score) with **Merge** / **Not the same
  person** actions.
- **List page** (`/settings/people`): a small badge on any card with a pending
  suggestion, so candidates are visible during triage without opening each one.
- **Merge direction is fixed**: the page you're viewing always survives (keeps
  its id, name, and cover); the suggested other person is always the one
  folded in. This is the reverse of the existing manual "Merge into…" picker's
  direction, and is deliberate — see "Merge direction" below.

## Goals

- Every clustering run computes, for each live/visible person, their single
  best-scoring other live/visible person by centroid cosine similarity, and
  stores it if it clears a merge-specific threshold.
- Detail page shows a dismissable/actionable banner when a suggestion exists.
- List page shows a lightweight badge for any person with a pending suggestion.
- Dismissing a suggestion permanently suppresses that pair (survives future
  clustering runs).
- One click on the banner's **Merge** commits immediately (no separate
  confirm), reusing the existing `POST /api/people/merge` primitive.
- Hidden people are excluded entirely — never a subject, never a candidate.

## Non-goals / out of scope

- Any new merge primitive. Reuse `mergePeopleInto` / `POST /api/people/merge`
  exactly as-is; this feature only decides which two ids to pass and in which
  direction.
- Showing more than one candidate per person. Top match only, matching the
  "one likely duplicate" mental model — no ranked list, no "compare 3
  candidates" UI.
- Mutual-nearest-neighbor gating or any second-pass quality heuristic beyond
  the threshold. If this proves too noisy in practice, tightening the
  threshold or adding that gate is a follow-up, not part of this design.
- Suggestions for hidden people, or involving them as a candidate target.
- Any change to the existing manual "Merge into…" dropdown's direction or
  behavior — it's untouched.

## Current state (what already exists)

- **Centroid**: `PersonDoc.centroid` / `centroid_face_count`
  (`src/api/src/db/schema.ts`) — mean L2-normalised MobileFaceNet embedding,
  refreshed by `recomputeCentroids()` (`src/api/src/people/cluster-load.ts`)
  after every clustering run. `loadCentroids()` in the same file already does
  one `find({ merged_into: null })` over every live person to seed the online
  clustering pass (`clusterEmbeddings` in `cluster-embeddings.ts`, cosine
  similarity via `dotProduct` over L2-normalised vectors, threshold
  `DEFAULT_SIMILARITY_THRESHOLD = 0.5`).
- **Merge primitive**: `mergePeopleInto(targetId, sourceIds[])`
  (`src/api/src/people/people-merge.repo.ts`) — target survives (id/name/
  cover/`created_at` kept), sources folded in via `mergeInto`, exposed as
  `POST /api/people/merge` (`src/api/src/routes/people.ts`). This is exactly
  what the banner's **Merge** action will call.
- **Manual "Merge into…" picker**: already on the detail page
  (`people.component.html`, `people-bulk.controller.ts`) — a named-people
  dropdown where **the current person is always the source**, the picked
  target always survives (`mergeDetailInto` → `performMerge`). The new
  suggestion banner uses the **opposite** direction on purpose (see below);
  it's a separate control, not a change to this one.
- **Hidden people**: `PersonDoc.hidden` — excluded from `listPeople` but kept
  as clustering seeds (`loadCentroids`/`recomputeCentroids` deliberately don't
  filter on `hidden`, so a hidden person keeps absorbing matching faces). The
  new suggestion pass adds a **second, narrower filter** on top, just for
  itself — hidden people are excluded from suggestions entirely, unlike the
  clustering seed set.

## Data model (`src/api/src/db/schema.ts`)

New `PersonDoc` fields, refreshed by the clustering job alongside `centroid`:

```ts
/** Best-matching other live, non-hidden, non-dismissed person by centroid
 * cosine similarity, if it clears MERGE_SUGGESTION_THRESHOLD. Refreshed each
 * clustering run; null when no qualifying match exists. */
suggested_merge_person_id?: ObjectId | null;
/** Cosine similarity score backing suggested_merge_person_id, for display
 * ("87% match"). Refreshed alongside the id; null when the id is null. */
suggested_merge_score?: number | null;
```

New collection for permanent dismissals — a person-level suggestion is
recomputed from scratch every run, so "not a match" needs to be remembered
independently of that recompute:

```ts
// person_merge_dismissals
export interface PersonMergeDismissalDoc {
  /** "idAHex:idBHex" with the two hex ids in ascending lexicographic order,
   * so a lookup for the pair (A, B) is direction-independent regardless of
   * which side initiated the dismiss. */
  pair: string;
  created_at: string;
}
```

Unique index on `pair` (added in `ensureIndexes`, alongside the existing
people indexes). New accessor `personMergeDismissalsCollection()` in
`src/api/src/db/client.ts`, following the existing per-collection accessor
pattern (`peopleCollection()`, `assetsCollection()`, etc.).

## Compute pipeline (`src/api`)

### Pure core — `src/api/src/people/people-merge-suggestions.ts` (new file)

Mirrors the existing `cluster-embeddings.ts` split: pure math, no Mongo, unit
testable on its own.

```ts
/** Stricter than clustering's face-to-cluster threshold (0.5) — a
 * false-positive merge suggestion is more disruptive than a false-positive
 * face assignment, since merging two whole people is harder to undo cleanly.
 * Empirically-chosen starting point, ratchet like DEFAULT_SIMILARITY_THRESHOLD
 * once we see real score distributions. */
export const MERGE_SUGGESTION_THRESHOLD = 0.65;

export interface SuggestionCandidate {
  personIdHex: string;
  centroid: Float32Array; // L2-normalised
  hidden: boolean;
}

export interface MergeSuggestion {
  personIdHex: string;
  suggestedPersonIdHex: string;
  score: number;
}

/**
 * All-pairs cosine similarity over people (not faces — a few hundred/
 * thousand rows, cheap compared to the face-level clustering pass). For each
 * non-hidden person, keep their single best-scoring other non-hidden person
 * if it clears `threshold` and isn't in `dismissedPairs`. One entry per
 * person that has a qualifying match — people with no qualifying match are
 * simply absent (caller writes null for them).
 */
export function computeMergeSuggestions(
  people: SuggestionCandidate[],
  dismissedPairs: ReadonlySet<string>,
  threshold: number = MERGE_SUGGESTION_THRESHOLD,
): MergeSuggestion[];
```

### Wiring — `cluster-load.ts` + `clustering-job.ts`

- Extend `loadCentroids()`'s existing query to also project `hidden` (one
  more field on the same `find()` — zero new reads). `name` is not needed by
  the pure core; the write-side already has full docs available if display
  data is needed later.
- Add `loadMergeDismissals(): Promise<Set<string>>` — one indexed query over
  `person_merge_dismissals`, returns the `pair` strings as a `Set`.
- In `clustering-job.ts` (the write-side orchestrator, same place
  `recomputeCentroids`'s results get written back), after centroids are
  loaded: call `computeMergeSuggestions(centroids, dismissals)`, then
  `bulkWrite` `suggested_merge_person_id`/`suggested_merge_score` across
  **every** live/non-hidden person — explicitly `$set` to `null` for anyone
  not in the result set, so a stale suggestion (target since merged, hidden,
  or dismissed) clears itself on the very next run instead of lingering.
  Runs on every `POST /api/people/cluster` invocation, same cadence as
  centroid recompute.

## API (`src/api/src/routes/people.ts`, `people.repo.ts`)

- **`GET /api/people/:id`** (`getPerson`) — when
  `suggested_merge_person_id` is set, one extra `findOne` for the target's
  display info (name, cover), added to the response:
  ```ts
  suggested_merge: { person_id, name, cover_asset_id, cover_bbox, score } | null
  ```
- **`GET /api/people`** (`listPeople` / `toPersonListRow`) — add
  `has_merge_suggestion: boolean` (`!!suggested_merge_person_id`, already on
  the doc being listed — no join) for the grid badge.
- **New `POST /api/people/:id/dismiss-merge-suggestion`**, body
  `{ other_id: string }` — mirrors the existing `/hide` route shape.
  Validates `other_id` matches the person's *current*
  `suggested_merge_person_id` — a mismatch (suggestion already changed or
  cleared server-side) maps to 404, mirroring the existing merge route's
  `person not found` / `person already merged` → 404 convention — writes the
  dismissal record (sorted pair) to `person_merge_dismissals`, and clears
  `suggested_merge_person_id`/`score` on **both** docs immediately — so the
  banner/badge disappear right away rather than waiting for the next
  clustering run.
- **No new merge endpoint.** The banner's **Merge** button calls the existing
  `POST /api/people/merge` with `target_id` = the current page's person,
  `source_ids` = `[suggested_person_id]` (see "Merge direction" below).

## Merge direction

The existing manual picker's direction — current person is always the
**source**, picked target always **survives** — is intentionally **not**
reused here. For the suggestion banner, **the person whose page you're on is
always the survivor**: its name, cover, and id are kept, and the suggested
other person is always folded in. This is simpler than a "prefer the named
one" heuristic (considered and dropped): it's a fixed, predictable rule with
no auto-name detection needed, and matches the mental model of standing on a
person's page and being offered a duplicate to absorb into it.

## Web (`maple-common`, `maple` people feature)

### Types (`bun-api-backend.service.ts`)

- `ApiPersonDetail` gains `suggestedMerge: ApiMergeSuggestion | null`.
- `ApiPerson` gains `hasMergeSuggestion: boolean`.
- New `ApiMergeSuggestion { personId: string; name: string; coverAssetId:
string | null; coverBbox: Bbox | null; score: number }`.
- New backend method `dismissMergeSuggestion(personId: string, otherId:
string): Observable<void>` → `POST /people/:id/dismiss-merge-suggestion`.

### `people.store.ts`

- `dismissMergeSuggestion(personId, otherId): Promise<void>` — await the API
  call, then `invalidateDetail(personId)` + `invalidate()` (list badge) +
  `invalidateDetail(otherId)` (the other side's own detail, if cached, should
  stop showing it too).
- The banner's merge action reuses the existing `store.mergePeople` — no new
  store method needed, just called with `(targetId = detail.id, sourceIds =
[suggestion.personId])`.

### Detail page — `people-detail.controller.ts` / `people.component.html`

- New controller method mirroring the existing `PeopleDetailController`
  shape: `mergeSuggestionInto(): void` — calls `performMerge` (the shared
  helper already used by the manual picker) with the fixed direction above,
  toast on success/failure, no navigation needed since the current page's id
  is unchanged (unlike the manual picker, which navigates to the target).
- `dismissSuggestion(): void` — calls `store.dismissMergeSuggestion`, toast on
  failure only (success is silent — the banner just disappears).
- Banner markup: placed near the existing `.detail-actions` block, shown when
  `detail.suggestedMerge` is non-null. Mini avatar (reuse the existing face-
  crop helper for a cover thumbnail), name, `{score}% match`, **Merge** /
  **Not the same person** buttons, disabled while `bulk.peopleBulkBusy() > 0`
  (shared busy counter with the rest of the detail actions).

### List page — `people.component.html` / `.scss`

- Small badge on any card where `hasMergeSuggestion` is true — same visual
  family as the existing `.unnamed-chip`. No click behavior of its own; the
  card's existing click-through to the detail page is unchanged, where the
  full banner lives.

## Edge cases, a11y, performance

- **No qualifying match**: `suggested_merge_person_id` is `null` — no banner,
  no badge. The common case for most people.
- **Suggested person merged/hidden/dismissed since the last clustering run**:
  `dismiss-merge-suggestion`'s validation (`other_id` must match the live
  suggestion) means a stale banner action fails cleanly with a toast, not a
  wrong merge; the next clustering run also self-heals via the explicit
  `null` writes described above.
- **In-flight**: both banner actions disabled while `bulk.peopleBulkBusy() >
0`, consistent with every other detail-page action.
- **a11y**: banner buttons get explicit labels (`"Merge with {name}"`, `"Not
the same person as {name}"`); the list badge needs an accessible label/title
  since it conveys information visually (e.g. `aria-label="Possible
duplicate"`).
- **Performance**: settings-surface work, not the render loop — the all-pairs
  pass is O(people²·512) over a few hundred/thousand rows, run once per
  clustering job invocation (not per page load), well within the existing
  clustering job's own cost envelope.

## Testing

- **API** (`bun test`, real throwaway Mongo per house practice):
  - `computeMergeSuggestions` (pure, no Mongo): symmetric-ish best-match
    selection, threshold cutoff, hidden exclusion, dismissed-pair exclusion,
    empty input, single person (no suggestion possible).
  - Clustering job integration: a run that produces two similar centroids
    writes `suggested_merge_person_id`/`score` on both; a subsequent run
    after one is hidden/merged clears the stale suggestion.
  - `POST /:id/dismiss-merge-suggestion`: happy path clears both docs and
    writes the dismissal record; mismatched `other_id` rejected; dismissed
    pair verified absent from the next `computeMergeSuggestions` pass even
    after centroids still score above threshold.
- **Web** (`bun run test` / vitest): `ApiMergeSuggestion` mapping (snake→camel
  in the backend service), `PeopleDetailController.mergeSuggestionInto` /
  `dismissSuggestion` (direction is fixed — assert `target_id` is always the
  current detail id), store invalidation on dismiss.
- **Format gate**: `bun run format` over `main...HEAD` before pushing.

## Files touched

| File                                                                      | Change                                                              |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `src/api/src/db/schema.ts`                                                | new `PersonDoc` fields; new `PersonMergeDismissalDoc`                |
| `src/api/src/db/client.ts`                                                | new `personMergeDismissalsCollection()`; unique index on `pair`      |
| `src/api/src/people/people-merge-suggestions.ts`                          | new — pure `computeMergeSuggestions` + threshold constant            |
| `src/api/src/people/people-merge-suggestions.test.ts`                     | new — pure-core unit tests                                            |
| `src/api/src/people/cluster-load.ts`                                     | `loadCentroids` projects `hidden`; new `loadMergeDismissals`          |
| `src/api/src/people/clustering-job.ts`                                   | wire suggestion pass + bulkWrite after centroid load                 |
| `src/api/src/people/people.repo.ts`                                      | `getPerson`/`toPersonListRow` include suggestion fields               |
| `src/api/src/routes/people.ts`                                          | new `POST /:id/dismiss-merge-suggestion`                              |
| `src/api/src/people/*.test.ts`                                           | route + integration tests                                             |
| `src/web/projects/maple-common/src/lib/api/bun-api-backend.service.ts`  | `ApiMergeSuggestion`, type additions, `dismissMergeSuggestion`         |
| `src/web/projects/maple-common/src/lib/api/people.store.ts`             | `dismissMergeSuggestion` + invalidation                               |
| `src/web/projects/maple/src/app/settings/people/people-detail.controller.ts` | `mergeSuggestionInto`, `dismissSuggestion`                       |
| `src/web/projects/maple/src/app/settings/people/people.component.html`  | detail banner; list badge                                             |
| `src/web/projects/maple/src/app/settings/people/people.component.scss`  | banner + badge styling                                                |
| `src/web/projects/maple/src/app/settings/people/*.spec.ts`               | controller/store unit tests                                           |

## Ticket

Open a GitHub issue (Files board) before implementation; the PR closes it with
a `Closes #N` line.
