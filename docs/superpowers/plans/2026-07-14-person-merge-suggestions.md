# Person-page merge suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a person's detail page (`/settings/people/:id`), proactively suggest a likely-duplicate person to merge, and surface a lightweight badge for the same on the list grid — reusing the existing centroid/clustering infrastructure and merge primitive rather than requiring the operator to recognize the duplicate by name.

**Architecture:** Every clustering run does one extra all-pairs cosine-similarity pass over already-loaded person centroids (in the off-thread load stage, `cluster-load.ts`), writing a `suggested_merge_person_id`/`score` onto each qualifying `PersonDoc`. The detail page reads this to show a banner; the list reads a derived boolean for a badge. Dismissing a suggestion writes a permanent pair-level "not a match" record and clears both docs immediately. The banner's merge button reuses the existing `POST /api/people/merge` — the only new rule is a fixed direction: the page you're viewing always survives.

**Tech Stack:** Bun + Elysia + MongoDB (`src/api`), Angular 21 standalone components + signals (`src/web`). No new external dependencies.

**Design doc:** `docs/superpowers/specs/2026-07-14-person-merge-suggestions-design.md` — read it for the full rationale (threshold choice, hidden-people exclusion, dismiss permanence, merge-direction decision). This plan implements that design; where this plan's exact mechanics differ from the design doc's looser description (the merge-suggestion compute pass actually runs inside `cluster-load.ts`'s off-thread `prepareClusteringPass`, not directly in `clustering-job.ts` as the design doc's wiring section loosely suggested — the design's *behavior* is unchanged, only the precise file is corrected here), this plan is authoritative on mechanics.

## Global Constraints

- **Non-destructive only** — this feature never touches original asset files; it only reads/writes `PersonDoc` fields and a new small collection. (CLAUDE.md §1)
- **No new env vars** — nothing here needs deploy-time config; `MERGE_SUGGESTION_THRESHOLD` is a code constant, not a setting, matching `DEFAULT_SIMILARITY_THRESHOLD`'s existing precedent. (CLAUDE.md "Configure via the settings system")
- **No mocks for Mongo-backed tests** — every API test in this plan uses the real throwaway-Mongo harness (`setupMongoHarness` from `people-repo.test-helpers.ts`), never a mocked collection. (CLAUDE.md "No mocks for the sidecar layer" — same house rule extends to all Mongo-backed repo tests in this codebase.)
- **Prefer functional/immutable style** — `const` over reassigned `let`, early returns, no mutation of function inputs. (CLAUDE.md "Prefer functional, immutable style")
- **API test gate:** `bun test` (no lint step exists for `src/api`). **Web style gate:** `bun run format` (Prettier) over the branch diff — there is no web lint step either.
- **Every PR closes a ticket** — open a GitHub issue (Files board) before implementation; the PR description must include `Closes #N`.
- **600-LOC file budget** — this plan already splits new logic into small, single-purpose files (`people-merge-suggestions.ts` pure core, `people-merge-suggestions.repo.ts` DB-backed dismiss action) rather than growing an existing file past budget.

---

## File Structure

New files:
- `src/api/src/people/people-merge-suggestions.ts` — pure core: threshold constant, types, `sortedPairKey`, `computeMergeSuggestions`. No Mongo — mirrors the existing `cluster-embeddings.ts` split.
- `src/api/src/people/people-merge-suggestions.test.ts` — unit tests for the above.
- `src/api/src/people/people-merge-suggestions.repo.ts` — DB-backed `dismissMergeSuggestion`. Mirrors the `people-merge.repo.ts` split (pure math vs. Mongo action, in separate files).
- `src/api/src/people/people-merge-suggestions.repo.test.ts` — unit tests for the above (real Mongo harness).
- `src/web/projects/maple/src/app/settings/people/people-bulk.controller.spec.ts` — first spec file for this controller; covers the two new methods.

Modified files (in task order):
- `src/api/src/db/schema.ts` — new `PersonDoc` fields, new `PersonMergeDismissalDoc`.
- `src/api/src/db/client.ts` — new `personMergeDismissalsCollection()` accessor + unique index.
- `src/api/src/people/cluster-load.ts` — `LoadedCentroid`/`loadCentroids` gain `hidden`; new `loadMergeDismissals`; `PreparedClusteringPass`/`prepareClusteringPass` gain `mergeSuggestions`.
- `src/api/src/people/clustering-job.test.ts` — new test coverage for the above (this file already hosts `cluster-load.ts`'s tests by convention).
- `src/api/src/people/clustering-job.ts` — persist `mergeSuggestions` via bulk write, self-healing stale entries to `null`.
- `src/api/src/people/people.repo.ts` — `getPerson` resolves `suggested_merge_person_id` into display info, defensively treating a stale/hidden/merged target as no suggestion.
- `src/api/src/people/people.repo.test.ts` — new test coverage for the above.
- `src/api/src/routes/people.ts` — wire `suggested_merge` into `GET /:id`, `has_merge_suggestion` into the list row, new `POST /:id/dismiss-merge-suggestion` route.
- `src/web/projects/maple-common/src/lib/api/bun-api-backend.service.ts` — `ApiMergeSuggestion` type, `ApiPerson`/`ApiPersonDetail` extensions, `dismissMergeSuggestion` method.
- `src/web/projects/maple-common/src/lib/api/people.store.ts` — `dismissMergeSuggestion` store method.
- `src/web/projects/maple-common/src/lib/api/people.store.spec.ts` — new test coverage for the above.
- `src/web/projects/maple/src/app/settings/people/people-bulk.controller.ts` — `mergeSuggestionInto`, `dismissSuggestion`.
- `src/web/projects/maple/src/app/settings/people/people.component.ts` — `suggestionCoverUrl` helper, `ApiMergeSuggestion` import.
- `src/web/projects/maple/src/app/settings/people/people.component.html` — detail banner, list badge.
- `src/web/projects/maple/src/app/settings/people/people.component.scss` — banner + badge styles.

---

### Task 1: Schema + DB client — dismissal collection + person doc fields

**Files:**
- Modify: `src/api/src/db/schema.ts` (near the `PersonDoc` interface, currently ending around line 887)
- Modify: `src/api/src/db/client.ts:23-47` (import block), `:168-170` (accessor block), and the end of `ensureIndexes()` (just before `await ensureStageIndexes(db);`)
- Test: `src/api/src/people/person-merge-dismissals.test.ts` (new)

**Interfaces:**
- Produces: `PersonDoc.suggested_merge_person_id?: ObjectId | null`, `PersonDoc.suggested_merge_score?: number | null`, `PersonMergeDismissalDoc { pair: string; created_at: string }`, `personMergeDismissalsCollection(): Promise<Collection<PersonMergeDismissalDoc>>`.

- [ ] **Step 1: Write the failing test**

Create `src/api/src/people/person-merge-dismissals.test.ts`:

```ts
/**
 * Tests for the `person_merge_dismissals` collection: the accessor and its
 * unique index on `pair`. Backing store for the person-page merge-suggestion
 * "not a match" dismiss action (`people-merge-suggestions.repo.ts`).
 */
import { describe, it, expect } from 'bun:test';
import { setupMongoHarness } from './people-repo.test-helpers.ts';

const TEST_DB = `maple_test_person_merge_dismissals_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

const h = setupMongoHarness(TEST_DB);

describe('personMergeDismissalsCollection', () => {
  it('round-trips a dismissal doc', async () => {
    if (!h.mongoReachable) return;
    const { personMergeDismissalsCollection } = await import('../db/client.ts');
    const coll = await personMergeDismissalsCollection();
    await coll.insertOne({ pair: 'aaa:bbb', created_at: new Date().toISOString() });
    const found = await coll.findOne({ pair: 'aaa:bbb' });
    expect(found?.pair).toBe('aaa:bbb');
  });

  it('rejects a duplicate pair via the unique index', async () => {
    if (!h.mongoReachable) return;
    const { personMergeDismissalsCollection } = await import('../db/client.ts');
    const coll = await personMergeDismissalsCollection();
    await coll.insertOne({ pair: 'ccc:ddd', created_at: new Date().toISOString() });
    await expect(
      coll.insertOne({ pair: 'ccc:ddd', created_at: new Date().toISOString() }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://localhost:27077 bun test src/people/person-merge-dismissals.test.ts`
Expected: FAIL — `personMergeDismissalsCollection` is not exported from `../db/client.ts`.

(If you don't have a throwaway Mongo on `:27077` yet, start one per house practice — see the "API integration tests need a real Mongo" note; any reachable MongoDB works, the harness skip-passes if none is reachable.)

- [ ] **Step 3: Add the schema fields**

In `src/api/src/db/schema.ts`, inside the `PersonDoc` interface (the block ending `face_count?: number; }` around line 887), add two new optional fields right after `hidden?: boolean;`:

```ts
  /** Best-matching other live, non-hidden, non-dismissed person by centroid
   * cosine similarity, if it clears MERGE_SUGGESTION_THRESHOLD
   * (`people-merge-suggestions.ts`). Refreshed by the clustering job
   * alongside `centroid`; null when no qualifying match exists. */
  suggested_merge_person_id?: ObjectId | null;
  /** Cosine similarity score backing `suggested_merge_person_id`, for
   * display ("87% match"). Refreshed alongside the id; null when the id
   * is null. */
  suggested_merge_score?: number | null;
```

Immediately after the `PersonDoc` interface's closing brace (before `export type PersonWithId = WithId<PersonDoc>;`), add:

```ts
/**
 * One permanently-dismissed "not a match" pair from the person-page
 * merge-suggestion banner. `pair` is direction-independent — see
 * `sortedPairKey` in `people-merge-suggestions.ts`, which is the single
 * source of the exact string format both the read and write sides use.
 */
export interface PersonMergeDismissalDoc {
  pair: string;
  created_at: string;
}
```

- [ ] **Step 4: Add the collection accessor + import**

In `src/api/src/db/client.ts`, add `PersonMergeDismissalDoc` to the `import type { ... } from './schema.ts';` block (line 23-47), alphabetical-ish placement next to `PersonDoc` is fine — just add the line:

```ts
  PersonMergeDismissalDoc,
```

right after the existing `PersonDoc,` line.

Then, right after the existing `peopleCollection()` accessor (around line 168-170):

```ts
export async function peopleCollection(): Promise<Collection<PersonDoc>> {
  return (await getDb()).collection<PersonDoc>('people');
}
```

add:

```ts

export async function personMergeDismissalsCollection(): Promise<
  Collection<PersonMergeDismissalDoc>
> {
  return (await getDb()).collection<PersonMergeDismissalDoc>('person_merge_dismissals');
}
```

- [ ] **Step 5: Add the unique index**

In `ensureIndexes()`, find the tail end of the function — it currently reads:

```ts
  await db
    .collection('mirror_queue')
    .createIndex({ dead: 1, claimed_at: 1, enqueued_at: 1 }, { name: 'mirror_queue_claim' });

  await ensureStageIndexes(db);

  log.info('indexes ensured');
}
```

Insert a new block right before `await ensureStageIndexes(db);`:

```ts
  // person_merge_dismissals: one row per permanently-dismissed "not a
  // match" pair from the person-page merge-suggestion banner. Unique on
  // `pair` so a duplicate dismiss of the same pair is a no-op (the repo
  // action upserts), not a duplicate row.
  await db
    .collection('person_merge_dismissals')
    .createIndex({ pair: 1 }, { unique: true, name: 'person_merge_dismissals_pair' });

  await ensureStageIndexes(db);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://localhost:27077 bun test src/people/person-merge-dismissals.test.ts`
Expected: PASS (2 tests), or both tests silently skip (return early) if Mongo is unreachable — either is an acceptable green run, matching this codebase's existing skip-pass convention.

- [ ] **Step 7: Commit**

```bash
git add src/api/src/db/schema.ts src/api/src/db/client.ts src/api/src/people/person-merge-dismissals.test.ts
git commit -m "feat(api): add PersonDoc merge-suggestion fields + dismissal collection"
```

---

### Task 2: Pure core — `computeMergeSuggestions`

**Files:**
- Create: `src/api/src/people/people-merge-suggestions.ts`
- Test: `src/api/src/people/people-merge-suggestions.test.ts`

**Interfaces:**
- Consumes: `dotProduct(a: Float32Array, b: Float32Array): number` from `./cluster-embeddings.ts` (already exists).
- Produces: `MERGE_SUGGESTION_THRESHOLD: number`, `SuggestionCandidate { personIdHex: string; centroid: Float32Array; hidden: boolean }`, `MergeSuggestion { personIdHex: string; suggestedPersonIdHex: string; score: number }`, `sortedPairKey(aHex: string, bHex: string): string`, `computeMergeSuggestions(people: SuggestionCandidate[], dismissedPairs: ReadonlySet<string>, threshold?: number): MergeSuggestion[]`.

- [ ] **Step 1: Write the failing tests**

Create `src/api/src/people/people-merge-suggestions.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import {
  computeMergeSuggestions,
  sortedPairKey,
  type SuggestionCandidate,
} from './people-merge-suggestions.ts';

function unit(personIdHex: string, direction: number[], hidden = false): SuggestionCandidate {
  const norm = Math.sqrt(direction.reduce((s, v) => s + v * v, 0));
  return {
    personIdHex,
    centroid: Float32Array.from(direction.map((v) => v / norm)),
    hidden,
  };
}

describe('sortedPairKey', () => {
  it('is direction-independent and lexicographically ordered', () => {
    expect(sortedPairKey('aaa', 'bbb')).toBe('aaa:bbb');
    expect(sortedPairKey('bbb', 'aaa')).toBe('aaa:bbb');
  });
});

describe('computeMergeSuggestions', () => {
  it('suggests a mutual match for two identical centroids above threshold', () => {
    const a = unit('a', [1, 0]);
    const b = unit('b', [1, 0]);
    const result = computeMergeSuggestions([a, b], new Set());
    expect(result).toEqual([
      { personIdHex: 'a', suggestedPersonIdHex: 'b', score: 1 },
      { personIdHex: 'b', suggestedPersonIdHex: 'a', score: 1 },
    ]);
  });

  it('omits a person whose best score is below the default threshold', () => {
    const a = unit('a', [1, 0]);
    const b = unit('b', [0, 1]); // orthogonal, cosine similarity 0
    expect(computeMergeSuggestions([a, b], new Set())).toEqual([]);
  });

  it('picks the closer of two candidates, not the first in array order', () => {
    const subject = unit('subject', [1, 0]);
    const far = unit('far', [0.8, 0.6]); // cos(subject, far) = 0.8
    const near = unit('near', [0.99, Math.sqrt(1 - 0.99 * 0.99)]); // cos ~ 0.99
    const result = computeMergeSuggestions([subject, far, near], new Set());
    const forSubject = result.find((r) => r.personIdHex === 'subject');
    expect(forSubject?.suggestedPersonIdHex).toBe('near');
  });

  it('excludes hidden people as both subject and candidate', () => {
    const a = unit('a', [1, 0]);
    const hiddenB = unit('hidden', [1, 0], true);
    expect(computeMergeSuggestions([a, hiddenB], new Set())).toEqual([]);
  });

  it('excludes a dismissed pair even when it scores above threshold', () => {
    const a = unit('a', [1, 0]);
    const b = unit('b', [1, 0]);
    const dismissed = new Set([sortedPairKey('a', 'b')]);
    expect(computeMergeSuggestions([a, b], dismissed)).toEqual([]);
  });

  it('returns no suggestions for a single person or an empty list', () => {
    expect(computeMergeSuggestions([], new Set())).toEqual([]);
    expect(computeMergeSuggestions([unit('solo', [1, 0])], new Set())).toEqual([]);
  });

  it('respects a custom threshold override', () => {
    const a = unit('a', [1, 0]);
    const c = unit('c', [0.6, 0.8]); // cos(a, c) = 0.6 — below default 0.65
    expect(computeMergeSuggestions([a, c], new Set())).toEqual([]);
    const result = computeMergeSuggestions([a, c], new Set(), 0.5);
    expect(result).toHaveLength(2);
    expect(result[0].suggestedPersonIdHex).toBe('c');
    expect(result[0].score).toBeCloseTo(0.6, 5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src/api && bun test src/people/people-merge-suggestions.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/api/src/people/people-merge-suggestions.ts`:

```ts
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

/**
 * All-pairs cosine similarity over people (not faces — a few hundred/
 * thousand rows, cheap compared to the face-level clustering pass). For
 * each non-hidden person, keep their single best-scoring OTHER non-hidden
 * person if it clears `threshold` and isn't in `dismissedPairs`. People
 * with no qualifying match are simply absent from the result — the caller
 * writes `null` for them.
 *
 * Ties break toward the first-encountered candidate (strict `>`, matching
 * `clusterEmbeddings`'s own tie-break convention) — deterministic given a
 * stable input order.
 */
export function computeMergeSuggestions(
  people: SuggestionCandidate[],
  dismissedPairs: ReadonlySet<string>,
  threshold: number = MERGE_SUGGESTION_THRESHOLD,
): MergeSuggestion[] {
  const visible = people.filter((p) => !p.hidden);
  const results: MergeSuggestion[] = [];
  for (const person of visible) {
    let bestScore = -Infinity;
    let bestOther: SuggestionCandidate | null = null;
    for (const other of visible) {
      if (other.personIdHex === person.personIdHex) continue;
      if (dismissedPairs.has(sortedPairKey(person.personIdHex, other.personIdHex))) continue;
      const score = dotProduct(person.centroid, other.centroid);
      if (score > bestScore) {
        bestScore = score;
        bestOther = other;
      }
    }
    if (bestOther && bestScore >= threshold) {
      results.push({
        personIdHex: person.personIdHex,
        suggestedPersonIdHex: bestOther.personIdHex,
        score: bestScore,
      });
    }
  }
  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src/api && bun test src/people/people-merge-suggestions.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/src/people/people-merge-suggestions.ts src/api/src/people/people-merge-suggestions.test.ts
git commit -m "feat(api): pure computeMergeSuggestions core"
```

---

### Task 3: `cluster-load.ts` — hidden flag, dismissals loader, wire into `prepareClusteringPass`

**Files:**
- Modify: `src/api/src/people/cluster-load.ts`
- Test: `src/api/src/people/clustering-job.test.ts` (append — this file already hosts `cluster-load.ts`'s tests by existing convention, since `recomputeCentroids`/`loadCentroids` are tested there today)

**Interfaces:**
- Consumes: `computeMergeSuggestions`, `MergeSuggestion` from `./people-merge-suggestions.ts` (Task 2); `personMergeDismissalsCollection` from `../db/client.ts` (Task 1).
- Produces: `LoadedCentroid.hidden: boolean` (new field), `loadMergeDismissals(): Promise<Set<string>>`, `PreparedClusteringPass.mergeSuggestions: MergeSuggestion[]` (new field).

- [ ] **Step 1: Write the failing test**

Append to `src/api/src/people/clustering-job.test.ts` (add near the existing `describe('recomputeCentroids', ...)` block — same file, new `describe`):

```ts
describe('prepareClusteringPass — merge suggestions', () => {
  it('suggests the best-matching other live, non-hidden person above threshold', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { prepareClusteringPass, EMBEDDING_DIM } = await import('./cluster-load.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const peopleC = await peopleCollection();

    const a = await createPerson('Person A');
    const b = await createPerson('Person B');
    const centroid = new Array(EMBEDDING_DIM).fill(0);
    centroid[0] = 1;
    await peopleC.updateOne({ _id: a._id }, { $set: { centroid, centroid_face_count: 5 } });
    await peopleC.updateOne({ _id: b._id }, { $set: { centroid, centroid_face_count: 5 } });

    const pass = await prepareClusteringPass();
    const forA = pass.mergeSuggestions.find((s) => s.personIdHex === a._id.toHexString());
    expect(forA?.suggestedPersonIdHex).toBe(b._id.toHexString());
    expect(forA?.score).toBeCloseTo(1, 5);
  });

  it('excludes a hidden person from suggestions', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { prepareClusteringPass, EMBEDDING_DIM } = await import('./cluster-load.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const peopleC = await peopleCollection();

    const a = await createPerson('Person C');
    const hiddenB = await createPerson('Person D');
    const centroid = new Array(EMBEDDING_DIM).fill(0);
    centroid[0] = 1;
    await peopleC.updateOne({ _id: a._id }, { $set: { centroid, centroid_face_count: 5 } });
    await peopleC.updateOne(
      { _id: hiddenB._id },
      { $set: { centroid, centroid_face_count: 5, hidden: true } },
    );

    const pass = await prepareClusteringPass();
    const forA = pass.mergeSuggestions.find((s) => s.personIdHex === a._id.toHexString());
    expect(forA).toBeUndefined();
  });

  it('excludes a dismissed pair', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { prepareClusteringPass, EMBEDDING_DIM } = await import('./cluster-load.ts');
    const { peopleCollection, personMergeDismissalsCollection } = await import('../db/client.ts');
    const { sortedPairKey } = await import('./people-merge-suggestions.ts');
    const peopleC = await peopleCollection();

    const a = await createPerson('Person E');
    const b = await createPerson('Person F');
    const centroid = new Array(EMBEDDING_DIM).fill(0);
    centroid[0] = 1;
    await peopleC.updateOne({ _id: a._id }, { $set: { centroid, centroid_face_count: 5 } });
    await peopleC.updateOne({ _id: b._id }, { $set: { centroid, centroid_face_count: 5 } });

    const dismissalsC = await personMergeDismissalsCollection();
    await dismissalsC.insertOne({
      pair: sortedPairKey(a._id.toHexString(), b._id.toHexString()),
      created_at: new Date().toISOString(),
    });

    const pass = await prepareClusteringPass();
    const forA = pass.mergeSuggestions.find((s) => s.personIdHex === a._id.toHexString());
    expect(forA).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://localhost:27077 bun test src/people/clustering-job.test.ts -t "merge suggestions"`
Expected: FAIL — `pass.mergeSuggestions` is `undefined` (property doesn't exist yet), or `EMBEDDING_DIM` isn't exported from `cluster-load.ts` yet.

- [ ] **Step 3: Extend `LoadedCentroid` and `loadCentroids`**

In `src/api/src/people/cluster-load.ts`, find the `LoadedCentroid` interface (currently):

```ts
export interface LoadedCentroid {
  person_id_hex: string;
  /** L2-normalised — cosine similarity is then a dot product. */
  centroid: Float32Array;
  /** Number of faces that contributed to the running mean. */
  face_count: number;
}
```

Add one field:

```ts
export interface LoadedCentroid {
  person_id_hex: string;
  /** L2-normalised — cosine similarity is then a dot product. */
  centroid: Float32Array;
  /** Number of faces that contributed to the running mean. */
  face_count: number;
  /** True for a soft-hidden person. Carried so the merge-suggestion pass
   * can exclude hidden people without a second query — clustering itself
   * deliberately does NOT filter on `hidden` (see the module header), this
   * field exists only for that second, narrower use. */
  hidden: boolean;
}
```

Find `loadCentroids()` (currently pushes `{ person_id_hex, centroid, face_count }`); add `hidden`:

```ts
export async function loadCentroids(): Promise<LoadedCentroid[]> {
  const peopleC = await peopleCollection();
  const rows = await peopleC.find({ merged_into: null } as Filter<PersonDoc>).toArray();
  const out: LoadedCentroid[] = [];
  for (const r of rows) {
    if (!r.centroid || r.centroid.length !== EMBEDDING_DIM) continue;
    out.push({
      person_id_hex: r._id.toHexString(),
      centroid: l2Normalise(Float32Array.from(r.centroid)),
      face_count: r.centroid_face_count ?? 0,
      hidden: r.hidden === true,
    });
  }
  return out;
}
```

- [ ] **Step 4: Add `loadMergeDismissals`**

Add the import (top of `cluster-load.ts`, alongside the existing `assetsCollection, peopleCollection` import from `../db/client.ts`):

```ts
import { assetsCollection, peopleCollection, personMergeDismissalsCollection } from '../db/client.ts';
```

Add a new exported function, near `loadCentroids`:

```ts
/** Every permanently-dismissed "not a match" pair, as a `Set` of
 * `sortedPairKey` strings, for `computeMergeSuggestions` to exclude. */
export async function loadMergeDismissals(): Promise<Set<string>> {
  const coll = await personMergeDismissalsCollection();
  const rows = await coll.find({}).project<{ pair: string }>({ pair: 1, _id: 0 }).toArray();
  return new Set(rows.map((r) => r.pair));
}
```

- [ ] **Step 5: Wire the suggestion pass into `PreparedClusteringPass`/`prepareClusteringPass`**

Add the import (top of `cluster-load.ts`):

```ts
import { computeMergeSuggestions, type MergeSuggestion } from './people-merge-suggestions.ts';
```

In the `PreparedClusteringPass` interface, add one field (after `recomputed`):

```ts
  /** Merge-suggestion pass over the loaded centroids (§ person-page merge
   * suggestions). One entry per person with a qualifying suggestion;
   * absent entries mean "no suggestion" — the write side (`clustering-
   * job.ts`) explicitly clears anyone not present here. */
  mergeSuggestions: MergeSuggestion[];
```

In `prepareClusteringPass()`, after the existing `const result = clusterEmbeddings(...)` call and before the `return`, add:

```ts
  // Merge-suggestion pass over the SAME loaded centroids — the only new
  // Mongo read is `loadMergeDismissals()`; no second centroid load.
  const dismissedPairs = await loadMergeDismissals();
  const mergeSuggestions = computeMergeSuggestions(
    centroids.map((c) => ({
      personIdHex: c.person_id_hex,
      centroid: c.centroid,
      hidden: c.hidden,
    })),
    dismissedPairs,
  );
```

Then add `mergeSuggestions` to the returned object (which currently ends `maxAutoIndex, recomputed, };`):

```ts
  return {
    seedCount: centroids.length,
    seedPersonIds: centroids.map((c) => c.person_id_hex),
    assignments: result.assignments,
    clusters: result.clusters.map((c) => ({
      centroid: Array.from(c.centroid),
      face_count: c.face_count,
    })),
    faces: faces.map((f) => ({
      asset_id_hex: f.asset_id_hex,
      face_index: f.face_index,
      bbox: f.bbox,
    })),
    maxAutoIndex,
    recomputed,
    mergeSuggestions,
  };
```

- [ ] **Step 6: Re-export `EMBEDDING_DIM` and `prepareClusteringPass` for the test**

The test imports `prepareClusteringPass, EMBEDDING_DIM` directly `from './cluster-load.ts'`. Confirm both are already exported from that file (`EMBEDDING_DIM` is re-exported at the top via `export { ..., EMBEDDING_DIM, ... } from './cluster-embeddings.ts';` inside `cluster-load.ts`, and `prepareClusteringPass` is defined there directly) — if `EMBEDDING_DIM` isn't already re-exported from `cluster-load.ts` itself, add:

```ts
export { EMBEDDING_DIM } from './cluster-embeddings.ts';
```

near the top of the file, alongside the other imports from `cluster-embeddings.ts`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://localhost:27077 bun test src/people/clustering-job.test.ts -t "merge suggestions"`
Expected: PASS (3 tests), or all skip if Mongo is unreachable.

- [ ] **Step 8: Run the full clustering-job test file to check for regressions**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://localhost:27077 bun test src/people/clustering-job.test.ts`
Expected: PASS (all tests, old and new).

- [ ] **Step 9: Commit**

```bash
git add src/api/src/people/cluster-load.ts src/api/src/people/clustering-job.test.ts
git commit -m "feat(api): compute merge suggestions in the clustering load stage"
```

---

### Task 4: `clustering-job.ts` — persist merge suggestions (with self-healing null-clear)

**Files:**
- Modify: `src/api/src/people/clustering-job.ts`
- Test: `src/api/src/people/clustering-job.test.ts` (append)

**Interfaces:**
- Consumes: `pass.seedPersonIds: string[]`, `pass.mergeSuggestions: MergeSuggestion[]` (Task 3).
- Produces: every live/`hidden`-irrelevant person considered by the load stage gets `suggested_merge_person_id`/`suggested_merge_score` written (or explicitly nulled) on each `runOnlineClustering()` call.

- [ ] **Step 1: Write the failing test**

Append to `src/api/src/people/clustering-job.test.ts`:

```ts
describe('runOnlineClustering — merge suggestion persistence', () => {
  it('writes suggested_merge_person_id/score for a qualifying pair, and self-heals to null once the match is hidden', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const { runOnlineClustering, EMBEDDING_DIM } = await import('./clustering-job.ts');
    const peopleC = await peopleCollection();

    const a = await createPerson('Person G');
    const b = await createPerson('Person H');
    const c = await createPerson('Person I');
    const matching = new Array(EMBEDDING_DIM).fill(0);
    matching[0] = 1;
    const distinct = new Array(EMBEDDING_DIM).fill(0);
    distinct[1] = 1;
    await peopleC.updateOne(
      { _id: a._id },
      { $set: { centroid: matching, centroid_face_count: 5 } },
    );
    await peopleC.updateOne(
      { _id: b._id },
      { $set: { centroid: matching, centroid_face_count: 5 } },
    );
    await peopleC.updateOne(
      { _id: c._id },
      { $set: { centroid: distinct, centroid_face_count: 5 } },
    );

    // No unassigned faces this run — purely exercises the merge-suggestion
    // write side against the manually-seeded centroids above. (Two people
    // scoring above the merge-suggestion threshold, while still being
    // separate people, is only reachable in practice via centroid drift
    // across many faces — setting centroids directly is the deterministic
    // way to exercise the write-side wiring in isolation; Task 3 already
    // covers the compute side the same way.)
    await runOnlineClustering();

    const freshA = await peopleC.findOne({ _id: a._id });
    const freshB = await peopleC.findOne({ _id: b._id });
    const freshC = await peopleC.findOne({ _id: c._id });
    expect(freshA?.suggested_merge_person_id?.toHexString()).toBe(b._id.toHexString());
    expect(freshA?.suggested_merge_score).toBeCloseTo(1, 5);
    expect(freshB?.suggested_merge_person_id?.toHexString()).toBe(a._id.toHexString());
    expect(freshC?.suggested_merge_person_id ?? null).toBeNull();

    // Hide B, re-run: A's suggestion self-heals to null (its only
    // qualifying match is now excluded from the pass).
    await peopleC.updateOne({ _id: b._id }, { $set: { hidden: true } });
    await runOnlineClustering();
    const afterHide = await peopleC.findOne({ _id: a._id });
    expect(afterHide?.suggested_merge_person_id ?? null).toBeNull();
    expect(afterHide?.suggested_merge_score ?? null).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://localhost:27077 bun test src/people/clustering-job.test.ts -t "merge suggestion persistence"`
Expected: FAIL — `suggested_merge_person_id` stays `undefined` on every person (nothing writes it yet).

- [ ] **Step 3: Add the import**

In `src/api/src/people/clustering-job.ts`, add to the existing imports:

```ts
import type { MergeSuggestion } from './people-merge-suggestions.ts';
```

- [ ] **Step 4: Add `persistMergeSuggestions` and call it**

Add a new private function near `persistCentroids` (which it mirrors):

```ts
/**
 * Bulk-write this run's merge-suggestion results across EVERY live person
 * the load stage considered (`seedPersonIds`), not just the ones with a
 * qualifying match — anyone absent from `suggestions` gets explicitly
 * cleared to `null` so a stale suggestion (dismissed, or the match since
 * hidden/merged/no-longer-best) self-heals on the very next run.
 */
async function persistMergeSuggestions(
  seedPersonIds: string[],
  suggestions: MergeSuggestion[],
): Promise<void> {
  if (seedPersonIds.length === 0) return;
  const byPerson = new Map(suggestions.map((s) => [s.personIdHex, s]));
  const peopleC = await peopleCollection();
  const ops: AnyBulkWriteOperation<PersonDoc>[] = seedPersonIds.map((idHex) => {
    const s = byPerson.get(idHex);
    return {
      updateOne: {
        filter: { _id: new ObjectId(idHex) },
        update: {
          $set: {
            suggested_merge_person_id: s ? new ObjectId(s.suggestedPersonIdHex) : null,
            suggested_merge_score: s ? s.score : null,
          },
        },
      },
    };
  });
  await peopleC.bulkWrite(ops);
}
```

In `runOnlineClustering()`, right after the existing `await persistCentroids(centroidsToPersist);` line, add:

```ts
  // Persist this run's merge suggestions (§ person-page merge suggestions).
  await persistMergeSuggestions(pass.seedPersonIds, pass.mergeSuggestions);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://localhost:27077 bun test src/people/clustering-job.test.ts -t "merge suggestion persistence"`
Expected: PASS.

- [ ] **Step 6: Run the full clustering-job test file to check for regressions**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://localhost:27077 bun test src/people/clustering-job.test.ts`
Expected: PASS (all tests).

- [ ] **Step 7: Commit**

```bash
git add src/api/src/people/clustering-job.ts src/api/src/people/clustering-job.test.ts
git commit -m "feat(api): persist merge suggestions each clustering run"
```

---

### Task 5: `people-merge-suggestions.repo.ts` — `dismissMergeSuggestion`

**Files:**
- Create: `src/api/src/people/people-merge-suggestions.repo.ts`
- Test: `src/api/src/people/people-merge-suggestions.repo.test.ts`

**Interfaces:**
- Consumes: `sortedPairKey` from `./people-merge-suggestions.ts` (Task 2); `peopleCollection`, `personMergeDismissalsCollection` from `../db/client.ts` (Task 1).
- Produces: `dismissMergeSuggestion(personId: ObjectId, otherId: ObjectId): Promise<'dismissed' | 'stale'>`.

- [ ] **Step 1: Write the failing tests**

Create `src/api/src/people/people-merge-suggestions.repo.test.ts`:

```ts
/**
 * Tests for `dismissMergeSuggestion` — the write path behind the person-page
 * merge-suggestion banner's "Not the same person" button.
 */
import { describe, it, expect } from 'bun:test';
import { setupMongoHarness } from './people-repo.test-helpers.ts';

const TEST_DB = `maple_test_people_merge_suggestions_repo_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

const h = setupMongoHarness(TEST_DB);

describe('dismissMergeSuggestion', () => {
  it('clears both sides and records the dismissal when otherId matches the live suggestion', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { peopleCollection, personMergeDismissalsCollection } = await import('../db/client.ts');
    const { dismissMergeSuggestion } = await import('./people-merge-suggestions.repo.ts');
    const peopleC = await peopleCollection();

    const a = await createPerson('Person A1');
    const b = await createPerson('Person B1');
    await peopleC.updateOne(
      { _id: a._id },
      { $set: { suggested_merge_person_id: b._id, suggested_merge_score: 0.9 } },
    );
    await peopleC.updateOne(
      { _id: b._id },
      { $set: { suggested_merge_person_id: a._id, suggested_merge_score: 0.9 } },
    );

    const result = await dismissMergeSuggestion(a._id, b._id);
    expect(result).toBe('dismissed');

    const freshA = await peopleC.findOne({ _id: a._id });
    const freshB = await peopleC.findOne({ _id: b._id });
    expect(freshA?.suggested_merge_person_id ?? null).toBeNull();
    expect(freshB?.suggested_merge_person_id ?? null).toBeNull();

    const dismissalsC = await personMergeDismissalsCollection();
    const stored = await dismissalsC.findOne({});
    expect(stored?.pair).toBe([a._id.toHexString(), b._id.toHexString()].sort().join(':'));
  });

  it('is idempotent — re-dismissing an already-dismissed pair does not throw', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const { dismissMergeSuggestion } = await import('./people-merge-suggestions.repo.ts');
    const peopleC = await peopleCollection();

    const a = await createPerson('Person X1');
    const b = await createPerson('Person Y1');
    await peopleC.updateOne(
      { _id: a._id },
      { $set: { suggested_merge_person_id: b._id, suggested_merge_score: 0.9 } },
    );
    await dismissMergeSuggestion(a._id, b._id);

    // Re-set the suggestion (as the next clustering run would try to) and
    // dismiss again — must not throw a duplicate-key error.
    await peopleC.updateOne(
      { _id: a._id },
      { $set: { suggested_merge_person_id: b._id, suggested_merge_score: 0.9 } },
    );
    await expect(dismissMergeSuggestion(a._id, b._id)).resolves.toBe('dismissed');
  });

  it('returns "stale" without writing anything when otherId does not match the live suggestion', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { dismissMergeSuggestion } = await import('./people-merge-suggestions.repo.ts');

    const a = await createPerson('Person M1');
    const b = await createPerson('Person N1');
    // a has no suggestion at all.
    const result = await dismissMergeSuggestion(a._id, b._id);
    expect(result).toBe('stale');
  });

  it("does not clear the other side's suggestion if it points elsewhere", async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const { dismissMergeSuggestion } = await import('./people-merge-suggestions.repo.ts');
    const peopleC = await peopleCollection();

    const a = await createPerson('Person P1');
    const b = await createPerson('Person Q1');
    const c = await createPerson('Person R1');
    await peopleC.updateOne(
      { _id: a._id },
      { $set: { suggested_merge_person_id: b._id, suggested_merge_score: 0.9 } },
    );
    // b's OWN best match is c, not a — asymmetric, allowed by the design.
    await peopleC.updateOne(
      { _id: b._id },
      { $set: { suggested_merge_person_id: c._id, suggested_merge_score: 0.95 } },
    );

    await dismissMergeSuggestion(a._id, b._id);

    const freshB = await peopleC.findOne({ _id: b._id });
    expect(freshB?.suggested_merge_person_id?.toHexString()).toBe(c._id.toHexString());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://localhost:27077 bun test src/people/people-merge-suggestions.repo.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/api/src/people/people-merge-suggestions.repo.ts`:

```ts
/**
 * DB-backed dismiss action for a person-page merge suggestion — the ONE
 * write path for "not the same person," permanently suppressing a pair via
 * `person_merge_dismissals` (checked by `computeMergeSuggestions` on every
 * subsequent clustering run) and clearing the live suggestion fields on
 * both docs immediately so the UI doesn't wait for the next run.
 */

import type { ObjectId } from 'mongodb';
import { peopleCollection, personMergeDismissalsCollection } from '../db/client.ts';
import { sortedPairKey } from './people-merge-suggestions.ts';

export type DismissMergeSuggestionResult = 'dismissed' | 'stale';

/**
 * Dismiss the suggestion between `personId` and `otherId`. Returns
 * `'stale'` without writing anything if `personId`'s CURRENT
 * `suggested_merge_person_id` isn't `otherId` — the suggestion already
 * changed or cleared server-side (the route maps this to 404, mirroring
 * the merge route's `person not found` → 404 convention).
 */
export async function dismissMergeSuggestion(
  personId: ObjectId,
  otherId: ObjectId,
): Promise<DismissMergeSuggestionResult> {
  const peopleC = await peopleCollection();
  const person = await peopleC.findOne({ _id: personId });
  if (!person || !person.suggested_merge_person_id?.equals(otherId)) {
    return 'stale';
  }

  const pair = sortedPairKey(personId.toHexString(), otherId.toHexString());
  const dismissalsC = await personMergeDismissalsCollection();
  await dismissalsC.updateOne(
    { pair },
    { $setOnInsert: { pair, created_at: new Date().toISOString() } },
    { upsert: true },
  );

  await peopleC.updateOne(
    { _id: personId },
    { $set: { suggested_merge_person_id: null, suggested_merge_score: null } },
  );
  // Only clear the OTHER side if it currently points back at `personId` —
  // don't clobber an unrelated suggestion `otherId` might independently have.
  await peopleC.updateOne(
    { _id: otherId, suggested_merge_person_id: personId },
    { $set: { suggested_merge_person_id: null, suggested_merge_score: null } },
  );

  return 'dismissed';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://localhost:27077 bun test src/people/people-merge-suggestions.repo.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/src/people/people-merge-suggestions.repo.ts src/api/src/people/people-merge-suggestions.repo.test.ts
git commit -m "feat(api): dismissMergeSuggestion repo action"
```

---

### Task 6: `people.repo.ts` — `getPerson` resolves `suggestedMerge`

**Files:**
- Modify: `src/api/src/people/people.repo.ts` (the `PersonDetail` interface around line 71-74, and `getPerson` around line 376-410ish)
- Test: `src/api/src/people/people.repo.test.ts` (append)

**Interfaces:**
- Produces: `SuggestedMergeInfo { personId: ObjectId; name: string; coverAssetId: string | null; coverBbox: Bbox | null; score: number }`, `PersonDetail.suggestedMerge: SuggestedMergeInfo | null` (new field).

- [ ] **Step 1: Write the failing tests**

Append to `src/api/src/people/people.repo.test.ts` (new `describe` block, following the existing dynamic-import-per-test style used throughout this file):

```ts
describe('getPerson — suggestedMerge', () => {
  it('resolves suggested_merge_person_id into display info', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, getPerson } = await import('./people.repo.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const peopleC = await peopleCollection();

    const subject = await createPerson('Person S1');
    const target = await createPerson('Person T1');
    await peopleC.updateOne(
      { _id: target._id },
      { $set: { cover_asset_id: 'abc123', cover_bbox: { x: 0, y: 0, w: 1, h: 1 } } },
    );
    await peopleC.updateOne(
      { _id: subject._id },
      { $set: { suggested_merge_person_id: target._id, suggested_merge_score: 0.87 } },
    );

    const detail = await getPerson(subject._id);
    expect(detail?.suggestedMerge?.personId.toHexString()).toBe(target._id.toHexString());
    expect(detail?.suggestedMerge?.name).toBe('Person T1');
    expect(detail?.suggestedMerge?.coverAssetId).toBe('abc123');
    expect(detail?.suggestedMerge?.score).toBe(0.87);
  });

  it('returns null when no suggestion is set', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, getPerson } = await import('./people.repo.ts');

    const subject = await createPerson('Person S2');
    const detail = await getPerson(subject._id);
    expect(detail?.suggestedMerge).toBeNull();
  });

  it('defensively returns null when the suggested target has since been merged away', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, getPerson } = await import('./people.repo.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const peopleC = await peopleCollection();

    const subject = await createPerson('Person S3');
    const target = await createPerson('Person T3');
    await peopleC.updateOne(
      { _id: subject._id },
      { $set: { suggested_merge_person_id: target._id, suggested_merge_score: 0.9 } },
    );
    await peopleC.updateOne({ _id: target._id }, { $set: { merged_into: subject._id } });

    const detail = await getPerson(subject._id);
    expect(detail?.suggestedMerge).toBeNull();
  });

  it('defensively returns null when the suggested target has since been hidden', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, getPerson } = await import('./people.repo.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const peopleC = await peopleCollection();

    const subject = await createPerson('Person S4');
    const target = await createPerson('Person T4');
    await peopleC.updateOne(
      { _id: subject._id },
      { $set: { suggested_merge_person_id: target._id, suggested_merge_score: 0.9 } },
    );
    await peopleC.updateOne({ _id: target._id }, { $set: { hidden: true } });

    const detail = await getPerson(subject._id);
    expect(detail?.suggestedMerge).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://localhost:27077 bun test src/people/people.repo.test.ts -t "suggestedMerge"`
Expected: FAIL — `detail.suggestedMerge` is `undefined` (property doesn't exist yet).

- [ ] **Step 3: Extend `PersonDetail` and add the resolver**

In `src/api/src/people/people.repo.ts`, find the `PersonDetail` interface (currently):

```ts
export interface PersonDetail {
  person: PersonWithId;
  faces: PersonDetailFace[];
}
```

Replace with:

```ts
/** Display info for a resolved `suggested_merge_person_id`, used by the
 * person-page merge-suggestion banner. */
export interface SuggestedMergeInfo {
  personId: ObjectId;
  name: string;
  coverAssetId: string | null;
  coverBbox: Bbox | null;
  score: number;
}

export interface PersonDetail {
  person: PersonWithId;
  faces: PersonDetailFace[];
  suggestedMerge: SuggestedMergeInfo | null;
}
```

(`Bbox` is already imported in this file for `PersonDetailFace`'s `bbox` field — no new import needed.)

Add a new private helper, near the other helpers at the top of the file:

```ts
/**
 * Resolve `person.suggested_merge_person_id` into display info for the
 * detail-page banner. Defensive: a target that's since been merged away or
 * hidden (stale between clustering runs) is treated as "no suggestion"
 * rather than surfacing a broken banner — the next clustering run
 * self-heals the stale reference on the SUBJECT's own doc (Task 4).
 */
async function loadSuggestedMergeInfo(
  coll: Collection<PersonDoc>,
  person: PersonWithId,
): Promise<SuggestedMergeInfo | null> {
  if (!person.suggested_merge_person_id || person.suggested_merge_score == null) return null;
  const target = await coll.findOne({ _id: person.suggested_merge_person_id });
  if (!target || target.merged_into || target.hidden) return null;
  return {
    personId: target._id,
    name: target.name,
    coverAssetId: target.cover_asset_id ?? null,
    coverBbox: target.cover_bbox ?? null,
    score: person.suggested_merge_score,
  };
}
```

- [ ] **Step 4: Call it from `getPerson`**

In `getPerson()`, find the final `return` statement (it currently returns `{ person, faces }` — check the exact tail of the function's aggregation-building code to find where `faces` is fully built). Change the tail to:

```ts
  const suggestedMerge = await loadSuggestedMergeInfo(coll, person);
  return { person, faces, suggestedMerge };
```

(`coll` is the same `peopleCollection()` handle already opened earlier in this function as `const coll = await peopleCollection();` — reuse it, don't open a second handle.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://localhost:27077 bun test src/people/people.repo.test.ts -t "suggestedMerge"`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the full people.repo test file to check for regressions**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://localhost:27077 bun test src/people/people.repo.test.ts`
Expected: PASS (all tests — every existing call site that destructures `{ person, faces }` from `getPerson`'s result still works since `suggestedMerge` is an additive field).

- [ ] **Step 7: Commit**

```bash
git add src/api/src/people/people.repo.ts src/api/src/people/people.repo.test.ts
git commit -m "feat(api): getPerson resolves suggestedMerge display info"
```

---

### Task 7: `routes/people.ts` — wire the wire format + new dismiss route

**Files:**
- Modify: `src/api/src/routes/people.ts`

**Interfaces:**
- Consumes: `PersonDetail.suggestedMerge` (Task 6), `PersonWithCount.person.suggested_merge_person_id` (Task 1, already on `PersonWithId`), `dismissMergeSuggestion` (Task 5).
- Produces: `GET /api/people/:id` response gains `suggested_merge`; `GET /api/people` (and `/hidden`) rows gain `has_merge_suggestion`; new `POST /api/people/:id/dismiss-merge-suggestion`.

No new test file for this task — routes in this codebase are thin wrappers with no dedicated HTTP-level test file (confirmed: `/merge`, `/hide`, `/unhide` etc. have none either; they're covered by the underlying repo tests, which is exactly what Tasks 5 and 6 already did). This task is verified manually in Task 12's dev-server walkthrough.

- [ ] **Step 1: Add the import**

Add to the existing imports in `src/api/src/routes/people.ts`:

```ts
import { dismissMergeSuggestion } from '../people/people-merge-suggestions.repo.ts';
```

- [ ] **Step 2: Extend the `GET /:id` response**

Find the `GET /:id` handler's return object (currently ends `... faces: detail.faces.map(...), offset, limit, };`). Add `suggested_merge` right after `cover_bbox`:

```ts
      return {
        id: detail.person._id.toHexString(),
        name: detail.person.name,
        created_at: detail.person.created_at,
        updated_at: detail.person.updated_at,
        cover_asset_id: detail.person.cover_asset_id ?? null,
        cover_bbox: detail.person.cover_bbox ?? null,
        suggested_merge: detail.suggestedMerge
          ? {
              person_id: detail.suggestedMerge.personId.toHexString(),
              name: detail.suggestedMerge.name,
              cover_asset_id: detail.suggestedMerge.coverAssetId,
              cover_bbox: detail.suggestedMerge.coverBbox,
              score: detail.suggestedMerge.score,
            }
          : null,
        faces: detail.faces.map((f) => ({
          asset_id: f.asset_id,
          face_index: f.face_index,
          abs_path: f.abs_path,
          bbox: f.bbox,
          confidence: f.confidence,
        })),
        offset,
        limit,
      };
```

- [ ] **Step 3: Extend `toPersonListRow`**

Find `toPersonListRow` (currently returns an object ending `created_at: r.person.created_at, updated_at: r.person.updated_at,`). Add one field:

```ts
function toPersonListRow(r: PersonWithCount) {
  return {
    id: r.person._id.toHexString(),
    name: r.person.name,
    face_count: r.faceCount,
    cover_asset_id: r.person.cover_asset_id ?? null,
    cover_address: r.coverAddress,
    cover_abs_path: r.coverAbsPath,
    cover_bbox: r.person.cover_bbox ?? null,
    has_merge_suggestion: r.person.suggested_merge_person_id != null,
    created_at: r.person.created_at,
    updated_at: r.person.updated_at,
  };
}
```

- [ ] **Step 4: Add the request body schema**

Add near the other `t.Object` body schemas (`NameBody`, `MergeBody`, etc.):

```ts
const DismissMergeSuggestionBody = t.Object({
  other_id: t.String({ minLength: 1 }),
});
```

- [ ] **Step 5: Add the new route**

Add a new route, placed near the existing `/merge` route (they're conceptually related):

```ts
  // ── Dismiss a merge suggestion: permanently mark a pair "not a match" ──
  .post(
    '/:id/dismiss-merge-suggestion',
    async ({ params, body, set }) => {
      const id = safeObjectId(params.id);
      const otherId = safeObjectId(body.other_id);
      if (!id || !otherId) {
        set.status = 400;
        return { error: 'invalid person id' };
      }
      const result = await dismissMergeSuggestion(id, otherId);
      if (result === 'stale') {
        set.status = 404;
        return { error: 'suggestion not found' };
      }
      return { ok: true };
    },
    { body: DismissMergeSuggestionBody },
  )
```

- [ ] **Step 6: Update the file's route-list doc comment**

At the top of `src/api/src/routes/people.ts`, the header comment lists every route. Add one line, near the existing `POST /api/people/merge` line:

```ts
 *   POST   /api/people/:id/dismiss-merge-suggestion — mark a merge suggestion "not a match"
```

- [ ] **Step 7: Run the full API test suite to check for regressions**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://localhost:27077 bun test`
Expected: PASS (all existing tests — this task only adds fields/a route, it doesn't change any existing response shape's existing fields).

- [ ] **Step 8: Commit**

```bash
git add src/api/src/routes/people.ts
git commit -m "feat(api): wire merge-suggestion fields + dismiss route into /api/people"
```

---

### Task 8: Web types — `bun-api-backend.service.ts`

**Files:**
- Modify: `src/web/projects/maple-common/src/lib/api/bun-api-backend.service.ts`

**Interfaces:**
- Produces: `ApiMergeSuggestion { personId: string; name: string; coverAssetId: string | null; coverBbox: Bbox | null; score: number }`, `ApiPerson.hasMergeSuggestion: boolean`, `ApiPersonDetail.suggestedMerge: ApiMergeSuggestion | null`, `dismissMergeSuggestion(id: string, otherId: string): Observable<{ ok: true }>`.

No new test file for this task — this file (the raw HTTP snake_case→camelCase mapping layer) has zero existing spec coverage anywhere in the codebase today (confirmed: no `bun-api-backend.service.spec.ts` exists), so adding one here would be inconsistent with the established boundary — this codebase tests the mapping's OUTPUT at the store layer instead (Task 9, via a stub of this service), which is exactly the existing convention `people.store.spec.ts` already follows. Verified for real (actual wire response, not a stub) in Task 12's dev-server walkthrough.

- [ ] **Step 1: Add `ApiMergeSuggestion` and extend `ApiPerson`/`ApiPersonDetail`**

Add a new exported interface, near `ApiPersonFace` (around line 1105-1111):

```ts
export interface ApiMergeSuggestion {
  personId: string;
  name: string;
  coverAssetId: string | null;
  coverBbox: Bbox | null;
  score: number;
}
```

In `ApiPerson` (around line 1066-1085), add one field at the end:

```ts
export interface ApiPerson {
  id: string;
  name: string;
  faceCount: number;
  coverAssetId: string | null;
  coverAddress?: string | null;
  coverAbsPath: string | null;
  coverBbox: Bbox | null;
  createdAt: string;
  updatedAt: string;
  hasMergeSuggestion: boolean;
}
```

In `ApiPersonDetail` (around line 1088-1103), add one field after `faces`:

```ts
export interface ApiPersonDetail {
  id: string;
  name: string;
  coverAssetId: string | null;
  coverBbox: Bbox | null;
  createdAt: string;
  updatedAt: string;
  offset?: number;
  limit?: number;
  faces: ApiPersonFace[];
  suggestedMerge: ApiMergeSuggestion | null;
}
```

- [ ] **Step 2: Extend the raw wire types**

In `ApiPersonRaw` (around line 1141-1151), add one field:

```ts
interface ApiPersonRaw {
  id: string;
  name: string;
  face_count: number;
  cover_asset_id?: string | null;
  cover_address?: string | null;
  cover_abs_path?: string | null;
  cover_bbox?: Bbox | null;
  created_at: string;
  updated_at: string;
  has_merge_suggestion: boolean;
}
```

In `ApiPersonDetailRaw` (around line 1153-1168), add a `suggested_merge` field, and a new `ApiMergeSuggestionRaw` interface right after it:

```ts
interface ApiPersonDetailRaw {
  id: string;
  name: string;
  cover_asset_id?: string | null;
  cover_bbox?: Bbox | null;
  created_at: string;
  updated_at: string;
  offset?: number;
  limit?: number;
  faces: Array<{
    asset_id: string;
    face_index: number;
    abs_path: string;
    bbox: Bbox;
    confidence: number;
  }>;
  suggested_merge: ApiMergeSuggestionRaw | null;
}

interface ApiMergeSuggestionRaw {
  person_id: string;
  name: string;
  cover_asset_id: string | null;
  cover_bbox: Bbox | null;
  score: number;
}
```

- [ ] **Step 3: Update `normalisePerson`**

```ts
function normalisePerson(r: ApiPersonRaw): ApiPerson {
  return {
    id: r.id,
    name: r.name,
    faceCount: r.face_count,
    coverAssetId: r.cover_asset_id ?? null,
    coverAddress: r.cover_address ?? null,
    coverAbsPath: r.cover_abs_path ?? null,
    coverBbox: r.cover_bbox ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    hasMergeSuggestion: r.has_merge_suggestion,
  };
}
```

- [ ] **Step 4: Update `getPerson`'s mapping**

```ts
  getPerson(id: string, page?: { offset: number; limit: number }): Observable<ApiPersonDetail> {
    const params =
      page != null
        ? new HttpParams().set('offset', String(page.offset)).set('limit', String(page.limit))
        : undefined;
    return this.http
      .get<ApiPersonDetailRaw>(`${this.base}/people/${id}`, params ? { params } : undefined)
      .pipe(
        map((r) => ({
          id: r.id,
          name: r.name,
          coverAssetId: r.cover_asset_id ?? null,
          coverBbox: r.cover_bbox ?? null,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          offset: r.offset ?? 0,
          limit: r.limit ?? 50,
          faces: r.faces.map((f) => ({
            assetId: f.asset_id,
            faceIndex: f.face_index,
            absPath: f.abs_path,
            bbox: f.bbox,
            confidence: f.confidence,
          })),
          suggestedMerge: r.suggested_merge
            ? {
                personId: r.suggested_merge.person_id,
                name: r.suggested_merge.name,
                coverAssetId: r.suggested_merge.cover_asset_id,
                coverBbox: r.suggested_merge.cover_bbox,
                score: r.suggested_merge.score,
              }
            : null,
        })),
      );
  }
```

- [ ] **Step 5: Add `dismissMergeSuggestion`**

Add right after the existing `unhidePerson` method:

```ts
  /** Permanently mark a merge suggestion "not a match" — clears it
   * server-side on both people and suppresses the pair on future
   * clustering runs. */
  dismissMergeSuggestion(id: string, otherId: string): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`${this.base}/people/${id}/dismiss-merge-suggestion`, {
      other_id: otherId,
    });
  }
```

- [ ] **Step 6: Run the maple-common build/typecheck to confirm no type errors**

Run: `cd src/web && bun x tsc -p projects/maple-common/tsconfig.lib.json --noEmit`
Expected: no new errors. (If this exact tsconfig path doesn't resolve, use `bun x ng build maple-common` instead — either confirms the added fields type-check across the library.)

- [ ] **Step 7: Commit**

```bash
git add src/web/projects/maple-common/src/lib/api/bun-api-backend.service.ts
git commit -m "feat(web): ApiMergeSuggestion type + dismissMergeSuggestion HTTP method"
```

---

### Task 9: `people.store.ts` — `dismissMergeSuggestion` store method

**Files:**
- Modify: `src/web/projects/maple-common/src/lib/api/people.store.ts` (add after the existing `mergePeople` method, around line 450)
- Test: `src/web/projects/maple-common/src/lib/api/people.store.spec.ts`

**Interfaces:**
- Consumes: `this.api.dismissMergeSuggestion(id, otherId)` (Task 8), `this.evictDetail(id)`, `this.invalidate()`, `this.invalidateDetail(id)` (all pre-existing store methods).
- Produces: `PeopleStore.dismissMergeSuggestion(personId: string, otherId: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

In `src/web/projects/maple-common/src/lib/api/people.store.spec.ts`, add to the `ApiStub` class:

```ts
  dismissMergeSuggestion = vi.fn((_id: string, _otherId: string) => of({ ok: true as const }));
```

Add a new `describe` block:

```ts
describe('dismissMergeSuggestion', () => {
  it('calls the API, evicts the other person, and refreshes this detail + the list', async () => {
    const { api } = makeBed();
    store = TestBed.inject(PeopleStore);
    store.ensureList();

    await store.dismissMergeSuggestion('p1', 'p2');

    expect(api.dismissMergeSuggestion).toHaveBeenCalledWith('p1', 'p2');
    expect(api.getPerson).toHaveBeenCalledWith('p1', { offset: 0, limit: DETAIL_FACE_PAGE_SIZE });
    expect(api.listPeople).toHaveBeenCalledTimes(2); // initial ensureList() + invalidate()
  });

  it('propagates a failure without evicting anything', async () => {
    const api = new ApiStub();
    api.dismissMergeSuggestion = vi.fn(() => throwError(() => new Error('boom')));
    makeBed(api);
    store = TestBed.inject(PeopleStore);

    await expect(store.dismissMergeSuggestion('p1', 'p2')).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src/web && bunx vitest run projects/maple-common/src/lib/api/people.store.spec.ts -t "dismissMergeSuggestion"`
Expected: FAIL — `store.dismissMergeSuggestion` is not a function yet.

- [ ] **Step 3: Write the implementation**

In `src/web/projects/maple-common/src/lib/api/people.store.ts`, add right after the existing `mergePeople` method:

```ts
  /** Permanently dismiss a merge suggestion ("not the same person"). Evicts
   * the other person's cached detail (no refetch — it'll fetch fresh next
   * time it's opened) and refreshes this person's detail + the list, so the
   * banner/badge disappear immediately. Throws on failure so the caller can
   * surface an error toast. */
  async dismissMergeSuggestion(personId: string, otherId: string): Promise<void> {
    await firstValueFrom(this.api.dismissMergeSuggestion(personId, otherId));
    this.evictDetail(otherId);
    this.invalidateDetail(personId);
    this.invalidate();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src/web && bunx vitest run projects/maple-common/src/lib/api/people.store.spec.ts -t "dismissMergeSuggestion"`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full store spec file to check for regressions**

Run: `cd src/web && bunx vitest run projects/maple-common/src/lib/api/people.store.spec.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add src/web/projects/maple-common/src/lib/api/people.store.ts src/web/projects/maple-common/src/lib/api/people.store.spec.ts
git commit -m "feat(web): PeopleStore.dismissMergeSuggestion"
```

---

### Task 10: `people-bulk.controller.ts` — `mergeSuggestionInto` / `dismissSuggestion`

**Files:**
- Modify: `src/web/projects/maple/src/app/settings/people/people-bulk.controller.ts`
- Test (new file): `src/web/projects/maple/src/app/settings/people/people-bulk.controller.spec.ts`

**Interfaces:**
- Consumes: `this.deps.selected(): ApiPersonDetail | null` (existing dep), `this.performMerge(targetId, sourceIds, after)` (existing private method), `this.deps.store.dismissMergeSuggestion(id, otherId)` (Task 9), `this.deps.toast` (existing dep), `errorMessage` from `./people.vm.ts` (already imported in this file).
- Produces: `PeopleBulkController.mergeSuggestionInto(): void`, `PeopleBulkController.dismissSuggestion(): Promise<void>`.

No new `PeopleBulkDeps` fields needed — `selected`, `store`, and `toast` are already present.

- [ ] **Step 1: Write the failing tests**

Create `src/web/projects/maple/src/app/settings/people/people-bulk.controller.spec.ts`:

```ts
/**
 * Unit tests for `PeopleBulkController`'s merge-suggestion actions
 * (`mergeSuggestionInto` / `dismissSuggestion`). The class is plain TS with
 * deps threaded through the constructor (see the file header comment), so
 * it's testable with fake deps and no TestBed — the same approach
 * `people.vm.spec.ts` uses for pure logic in this feature.
 */
import { signal } from '@angular/core';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ApiPerson, ApiPersonDetail } from '@maple-common';
import { PeopleBulkController, type PeopleBulkDeps } from './people-bulk.controller';

function detailWithSuggestion(overrides: Partial<ApiPersonDetail> = {}): ApiPersonDetail {
  return {
    id: 'current',
    name: 'Current Person',
    coverAssetId: null,
    coverBbox: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    faces: [],
    suggestedMerge: {
      personId: 'other',
      name: 'Other Person',
      coverAssetId: null,
      coverBbox: null,
      score: 0.9,
    },
    ...overrides,
  };
}

describe('PeopleBulkController — merge suggestions', () => {
  let mergePeople: ReturnType<typeof vi.fn>;
  let dismissMergeSuggestion: ReturnType<typeof vi.fn>;
  let toast: ReturnType<typeof vi.fn>;
  let selected: ReturnType<typeof signal<ApiPersonDetail | null>>;
  let controller: PeopleBulkController;
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mergePeople = vi
      .fn()
      .mockResolvedValue({ id: 'current', name: 'Current Person', mergedCount: 1 });
    dismissMergeSuggestion = vi.fn().mockResolvedValue(undefined);
    toast = vi.fn();
    selected = signal<ApiPersonDetail | null>(detailWithSuggestion());
    confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);

    const deps: PeopleBulkDeps = {
      store: { mergePeople, dismissMergeSuggestion } as unknown as PeopleBulkDeps['store'],
      router: { navigate: vi.fn() } as unknown as PeopleBulkDeps['router'],
      people: signal<ApiPerson[]>([]),
      namedPeople: signal<ApiPerson[]>([]),
      selected,
      toast,
    };
    controller = new PeopleBulkController(deps);
  });

  afterEach(() => {
    confirmSpy.mockRestore();
  });

  it('mergeSuggestionInto: merges the suggested person INTO the current page (fixed direction)', async () => {
    controller.mergeSuggestionInto();
    await Promise.resolve();
    await Promise.resolve();

    expect(confirmSpy).toHaveBeenCalled();
    expect(mergePeople).toHaveBeenCalledWith('current', ['other']);
  });

  it('mergeSuggestionInto: no-ops when there is no open person or no suggestion', () => {
    selected.set(null);
    controller.mergeSuggestionInto();
    expect(mergePeople).not.toHaveBeenCalled();

    selected.set(detailWithSuggestion({ suggestedMerge: null }));
    controller.mergeSuggestionInto();
    expect(mergePeople).not.toHaveBeenCalled();
  });

  it('dismissSuggestion: calls the store with (current id, suggested id)', async () => {
    await controller.dismissSuggestion();
    expect(dismissMergeSuggestion).toHaveBeenCalledWith('current', 'other');
    expect(toast).not.toHaveBeenCalled();
  });

  it('dismissSuggestion: toasts on failure', async () => {
    dismissMergeSuggestion.mockRejectedValueOnce(new Error('boom'));
    await controller.dismissSuggestion();
    expect(toast).toHaveBeenCalledWith('boom', 'error');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src/web && bunx vitest run projects/maple/src/app/settings/people/people-bulk.controller.spec.ts`
Expected: FAIL — `mergeSuggestionInto`/`dismissSuggestion` are not functions yet.

- [ ] **Step 3: Write the implementation**

In `src/web/projects/maple/src/app/settings/people/people-bulk.controller.ts`, add two new public methods at the end of the class (after `mergeDetailInto`, before the closing brace):

```ts
  /** Merge the currently-open person's suggested duplicate INTO this page —
   * the OPPOSITE direction from `mergeDetailInto`: here the page you're on
   * always survives (keeps its id/name/cover), the suggested other person
   * is always the one folded in. Fixed rule, not a "prefer the named one"
   * heuristic — see the merge-suggestions design doc. */
  mergeSuggestionInto(): void {
    const detail = this.deps.selected();
    const suggestion = detail?.suggestedMerge;
    if (!detail || !suggestion) return;
    void this.performMerge(detail.id, [suggestion.personId], () => {});
  }

  /** "Not the same person" — permanently dismisses the suggestion so it
   * doesn't resurface on the next clustering run. */
  async dismissSuggestion(): Promise<void> {
    const detail = this.deps.selected();
    const suggestion = detail?.suggestedMerge;
    if (!detail || !suggestion) return;
    try {
      await this.deps.store.dismissMergeSuggestion(detail.id, suggestion.personId);
    } catch (err) {
      this.deps.toast(errorMessage(err), 'error');
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src/web && bunx vitest run projects/maple/src/app/settings/people/people-bulk.controller.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/projects/maple/src/app/settings/people/people-bulk.controller.ts src/web/projects/maple/src/app/settings/people/people-bulk.controller.spec.ts
git commit -m "feat(web): PeopleBulkController merge-suggestion actions"
```

---

### Task 11: Detail banner + list badge (template, styles, component wiring)

**Files:**
- Modify: `src/web/projects/maple/src/app/settings/people/people.component.ts` (import `ApiMergeSuggestion`; add `suggestionCoverUrl`)
- Modify: `src/web/projects/maple/src/app/settings/people/people.component.html` (detail banner; list badge)
- Modify: `src/web/projects/maple/src/app/settings/people/people.component.scss` (banner + badge styles)

**Interfaces:**
- Consumes: `detail.suggestedMerge: ApiMergeSuggestion | null` (Task 8), `p.hasMergeSuggestion: boolean` (Task 8), `bulk.mergeSuggestionInto()`/`bulk.dismissSuggestion()`/`bulk.peopleBulkBusy()` (Task 10), existing `this.people()`, `this.coverThumbUrl()`, `this.thumbs`, `crop.transform()`/`crop.onImgLoad()`.

No automated test for this task (template/styles aren't meaningfully unit-testable) — verified by hand against the running dev server in this task's own Step 5, per CLAUDE.md's "test the golden path in a browser before reporting complete" for UI changes. Task 12 repeats this as part of the final full walkthrough.

- [ ] **Step 1: Add the component-level helper**

In `src/web/projects/maple/src/app/settings/people/people.component.ts`, add `ApiMergeSuggestion` to the existing `@maple-common` import list:

```ts
import {
  ApiMergeSuggestion,
  ApiPerson,
  ApiPersonDetail,
  ApiPersonFace,
  BunApiBackendService,
  FilesystemBrowseService,
  LIBRARY_SOURCE,
  type LibrarySource,
  PeopleStore,
} from '@maple-common';
```

Add a new method right after the existing `detailCoverUrl`:

```ts
  suggestionCoverUrl(suggestion: ApiMergeSuggestion): string | null {
    const original = this.people().find((p) => p.id === suggestion.personId);
    if (original) return this.coverThumbUrl(original);
    if (!suggestion.coverAssetId) return null;
    return this.thumbs.url(`apiId:${suggestion.coverAssetId}`);
  }
```

- [ ] **Step 2: Add the detail-page banner**

In `src/web/projects/maple/src/app/settings/people/people.component.html`, the detail view's header currently ends:

```html
        <div class="detail-actions">
          ...
        </div>
      </div>
    </div>

    <!-- Filter bar -->
```

Insert the banner between `.detail-head`'s closing `</div>` and the `<!-- Filter bar -->` comment:

```html
      </div>
    </div>

    @if (detail.suggestedMerge; as suggestion) {
      <div class="merge-suggestion-banner">
        <div class="merge-suggestion-avatar">
          @if (suggestionCoverUrl(suggestion); as url) {
            @if (suggestion.coverBbox; as bbox) {
              <img
                [src]="url"
                [style.transform]="crop.transform(bbox, url)"
                style="transform-origin: 0 0"
                alt=""
                decoding="async"
                (load)="crop.onImgLoad(url, $event)"
              />
            } @else {
              <img class="cover-fill" [src]="url" alt="" decoding="async" />
            }
          } @else {
            <span class="merge-suggestion-avatar-fallback">{{
              suggestion.name.slice(0, 1).toUpperCase()
            }}</span>
          }
        </div>
        <div class="merge-suggestion-text">
          <strong>{{ suggestion.name }}</strong> might be the same person —
          {{ suggestion.score * 100 | number: '1.0-0' }}% match
        </div>
        <div class="merge-suggestion-actions">
          <button
            type="button"
            class="btn-primary"
            [disabled]="bulk.peopleBulkBusy() > 0"
            [attr.aria-label]="'Merge with ' + suggestion.name"
            (click)="bulk.mergeSuggestionInto()"
          >
            Merge
          </button>
          <button
            type="button"
            class="btn-ghost"
            [disabled]="bulk.peopleBulkBusy() > 0"
            [attr.aria-label]="'Not the same person as ' + suggestion.name"
            (click)="bulk.dismissSuggestion()"
          >
            Not the same person
          </button>
        </div>
      </div>
    }

    <!-- Filter bar -->
```

(`DecimalPipe`'s `number` pipe and the `crop` helper are already used elsewhere in this same template — no new imports needed.)

- [ ] **Step 3: Add the list-grid badge**

In the same file, the list-view card's `.person-thumb` block currently starts:

```html
                  <div class="person-thumb">
                    @if (bulk.selectMode()) {
                      <span class="select-check" ...> ... </span>
                    }
                    @if (coverThumbUrl(p); as url) {
```

Insert a badge block between the `@if (bulk.selectMode())` block and the `@if (coverThumbUrl(p); as url)` block:

```html
                  <div class="person-thumb">
                    @if (bulk.selectMode()) {
                      <span class="select-check" [class.is-selected]="bulk.isPersonSelected(p.id)">
                        @if (bulk.isPersonSelected(p.id)) {
                          <maple-settings-icon
                            name="check"
                            [size]="12"
                            color="#ffffff"
                            [stroke]="2.4"
                          />
                        }
                      </span>
                    }
                    @if (p.hasMergeSuggestion) {
                      <span class="merge-suggestion-badge" title="Possible duplicate" aria-label="Possible duplicate">
                        <maple-settings-icon name="merge" [size]="11" color="#ffffff" />
                      </span>
                    }
                    @if (coverThumbUrl(p); as url) {
```

- [ ] **Step 4: Add the styles**

In `src/web/projects/maple/src/app/settings/people/people.component.scss`, add after the existing `.detail-actions` block (around line 371-377):

```scss
// ── Detail view: merge-suggestion banner ────────────────────────────

.merge-suggestion-banner {
  margin: 0 36px 16px;
  padding: 12px 16px;
  border-radius: 8px;
  background: var(--s-surface2);
  border: 0.5px solid var(--s-border);
  display: flex;
  align-items: center;
  gap: 12px;
}

.merge-suggestion-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--s-surface2);
  border: 0.5px solid var(--s-border);
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;

  img {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .cover-fill {
    inset: 0;
  }
}

.merge-suggestion-avatar-fallback {
  font-size: 15px;
  color: var(--s-text-dim);
}

.merge-suggestion-text {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--s-text-mid);

  strong {
    color: var(--s-text);
  }
}

.merge-suggestion-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
```

Add near the existing `.select-check` block (around line 602-614), a sibling badge positioned on the opposite corner:

```scss
.merge-suggestion-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(13, 12, 11, 0.55);
  border: 1.5px solid #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(4px);
}
```

- [ ] **Step 5: Verify in the running dev server**

This step needs real backend data — the simplest way to get a suggestion showing without running a full clustering pass is to hand-seed two people directly in the dev Mongo:

```bash
mongosh mongodb://localhost:27017/maple --eval '
  const people = db.people.find({ merged_into: null }).limit(2).toArray();
  if (people.length >= 2) {
    db.people.updateOne({ _id: people[0]._id }, { $set: { suggested_merge_person_id: people[1]._id, suggested_merge_score: 0.87 } });
    db.people.updateOne({ _id: people[1]._id }, { $set: { suggested_merge_person_id: people[0]._id, suggested_merge_score: 0.87 } });
    print("seeded suggestion between " + people[0].name + " and " + people[1].name);
  } else {
    print("need at least 2 people in the dev DB — open the People settings page once to auto-create some, or run a clustering pass first");
  }
'
```

Then, with `bun run dev` (API) and `bun x ng serve maple` (web) both running:

1. Open `/settings/people`, confirm the badge (small merge icon, top-right of the thumb) appears on the two seeded cards.
2. Open one of the two people's detail page. Confirm the banner appears with the other person's name, avatar, and match score.
3. Click "Not the same person." Confirm the banner disappears and the badge is gone from both cards on the list (may need a manual refresh if the list isn't live-subscribed).
4. Re-seed the suggestion (re-run the `mongosh` snippet above) and open the detail page again. Click "Merge." Confirm a native browser confirm dialog appears, confirm it, and the page updates to show the combined face count with no navigation (the URL doesn't change, since the current page's person is always the target/survivor).

- [ ] **Step 6: Commit**

```bash
git add src/web/projects/maple/src/app/settings/people/people.component.ts src/web/projects/maple/src/app/settings/people/people.component.html src/web/projects/maple/src/app/settings/people/people.component.scss
git commit -m "feat(web): merge-suggestion banner + list badge"
```

---

### Task 12: Full regression pass + format check

**Files:** none (verification only)

- [ ] **Step 1: Run the full API test suite**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://localhost:27077 bun test`
Expected: PASS (every test — new and pre-existing).

- [ ] **Step 2: Run the full web test suite**

Run: `cd src/web && bun run test`
Expected: PASS. (If any pre-existing failures are unrelated to this feature, confirm via `git stash` + re-run that they also fail on `main` — the bar is "no NEW failures," per this repo's established convention for `src/web`.)

- [ ] **Step 3: Format check**

Run: `cd src/web && bun run format:check`
Expected: clean (no diffs). If it reports files, run `bun run format` and re-check — this is the only style gate for `src/web` (no lint step exists).

- [ ] **Step 4: Color-pipeline / parity harness sanity check**

This feature touches no color pipeline, GPU path, or XMP schema — `src/scripts/test_color_pipeline.sh` is not expected to be affected. Skip running it for this change (per CLAUDE.md, it's gated on fixtures that may not even be present locally, and this PR's diff has no `raw-core`/`raw-ffi`/`raw-wasm` touches).

- [ ] **Step 5: Full manual golden-path walkthrough**

With both dev servers running (`bun run dev` in `src/api`, `bun x ng serve maple` in `src/web`):

1. Repeat Task 11 Step 5's walkthrough end-to-end once more, in order: badge visible → banner visible → dismiss works → re-seed → merge works.
2. Additionally, confirm the merge's `target_id`/`source_ids` direction by checking the Network tab: the `POST /api/people/merge` request body's `target_id` must equal the CURRENTLY-OPEN person's id (the page you were on), and `source_ids` must be `[the suggested person's id]` — this is the one behavior a screenshot alone can't confirm, so read the actual request payload.
3. Confirm a genuinely-unrelated person (no suggestion seeded) shows neither a badge nor a banner — the common/default case.

- [ ] **Step 6: Open a GitHub issue and reference it**

Per CLAUDE.md, every PR closes a ticket:

```bash
gh issue create --title "Person page: suggest a likely duplicate to merge" \
  --body "Implements docs/superpowers/specs/2026-07-14-person-merge-suggestions-design.md — see that doc for full rationale." \
  --project "Files"
```

Note the issue number for the PR description's `Closes #N` line.

- [ ] **Step 7: Final commit (if anything changed during verification)**

If Step 3's format check required changes, or any fixups were needed during the manual walkthrough:

```bash
git add -A
git status  # review before committing — confirm nothing unexpected is staged
git commit -m "chore: format fixes from final verification pass"
```

(If nothing changed, skip this step — there's nothing to commit.)

---

## Self-Review Notes

- **Spec coverage:** every design-doc requirement maps to a task — data model (Task 1), pure compute + threshold (Task 2), wiring into the load stage (Task 3), persistence + self-heal (Task 4), dismiss action (Task 5), detail resolution (Task 6), API wire format (Task 7), web types (Task 8), store (Task 9), controller actions (Task 10), UI (Task 11), full regression (Task 12).
- **One correction from the design doc, caught while writing this plan:** the design doc's "Merge direction" section says the banner's Merge action "commits immediately, no extra confirm modal," reasoning that the existing manual "Merge into…" dropdown has no confirm step either. That's incorrect — the actual `performMerge` helper (which both flows share) DOES call the browser's native `confirm()` before merging. Task 10 reuses `performMerge` as-is (the right DRY choice — a parallel confirm-less code path would be its own inconsistency), so the suggestion banner's Merge button WILL show a native confirm dialog, matching the app's one existing merge affordance. This doesn't change the user-approved direction decision (target = current page), only corrects a confirmation-UX detail the design doc got wrong.
- **Type consistency check:** `MergeSuggestion.personIdHex`/`.suggestedPersonIdHex`/`.score` (Task 2) flow unchanged through `PreparedClusteringPass.mergeSuggestions` (Task 3) into `persistMergeSuggestions` (Task 4) — same field names throughout, no renaming drift. `ApiMergeSuggestion.personId`/`.name`/`.coverAssetId`/`.coverBbox`/`.score` (Task 8) match what Task 10's controller and Task 11's template read (`suggestion.personId`, `suggestion.name`, `suggestion.score`, `suggestion.coverBbox`) — verified consistent.
- **No placeholders:** every step above has complete, concrete code — no "add appropriate handling," no repeated "similar to Task N."
