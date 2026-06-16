# People Bulk Select → Hide / Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-select mode to the People settings list (`/settings/people`) with a toolbar to bulk-hide and bulk-merge the selected people into a named target, and make the person-detail "Merge into…" action a deterministic merge that navigates to the target.

**Architecture:** A thin, deterministic merge entry point (`mergePeopleInto` + `POST /api/people/merge`) reuses the existing `mergeInto` primitive with the chosen target forced as survivor (keeps its id/cover/created_at). The web list grows a select mode + floating toolbar (reusing the existing `.bulk-toolbar` pattern); both the list toolbar and the detail button share one `performMerge` component method. Bulk hide fans out the existing per-person soft-hide.

**Tech Stack:** Bun + Elysia + MongoDB (`src/api`); Angular 21 standalone + signals (`src/web`); `bun:test` (API, real Mongo, per-PID DB, skip-pass) and Vitest (web pure-VM specs).

**Closes:** #1303
**Spec:** `docs/superpowers/specs/2026-06-15-people-bulk-select-merge-hide-design.md`

---

## Conventions for the executor

- **Run tests directly — never pipe long-running build/test output through `tail`/`head`** (the watchdog kills piped long compiles). Let commands print in full.
- API tests need a local MongoDB on `mongodb://localhost:27017`; they use an isolated per-PID DB and skip-pass if Mongo is unreachable. Do **not** point them at the dev DB — the harness already sets `MAPLE_MONGO_DB` to a throwaway name.
- Commit after each task with the message shown in its final step.

---

## Task 1: Backend repo — `mergePeopleInto`

> **Post-review amendment (applied in a follow-up `fix(api/people)` commit):** the code below originally had `mergeInto` return a face count and surfaced `facesRepointed`/`faces_repointed`. Code review found that count is `updateMany.modifiedCount` (asset documents, not faces) and it was unused by the UI, so it was **dropped everywhere**: `mergeInto` stays `Promise<void>`, `MergePeopleResult` is `{ survivor, mergedCount }`, and the route returns `{ id, name, merged_count }`. `mergePeopleInto` also calls `markAssetsForMeiliReindexBestEffort([targetId, ...sourceIds])` after the loop (parity with `renamePerson`). The blocks below are the original plan; the follow-up commit is the source of truth.

**Files:**

- Modify: `src/api/src/people/people.repo.ts`
- Test: `src/api/src/people/people.repo.test.ts`

- [ ] **Step 1: Write the failing tests**

Append this `describe` block to `src/api/src/people/people.repo.test.ts` (after the existing `renamePerson` block, before `describe('people.repo — listPeople', …)` — anywhere at top level is fine):

```ts
describe('people.repo — mergePeopleInto', () => {
  it('folds sources into the target: target survives, faces repointed, sources merged', async () => {
    if (!mongoReachable) return;
    const { createPerson, mergePeopleInto, getPerson } = await import('./people.repo.ts');
    const target = await createPerson('Alice');
    const srcA = await createPerson('Person 1');
    const srcB = await createPerson('Person 2');
    const bbox = { x: 0, y: 0, w: 10, h: 10 };
    await insertAssetWithFaces([{ bbox, person_id: target._id.toHexString(), confidence: 0.9 }]);
    await insertAssetWithFaces([{ bbox, person_id: srcA._id.toHexString(), confidence: 0.9 }]);
    await insertAssetWithFaces([{ bbox, person_id: srcB._id.toHexString(), confidence: 0.9 }]);

    const result = await mergePeopleInto(target._id, [srcA._id, srcB._id]);

    expect(result.survivor._id.toHexString()).toBe(target._id.toHexString());
    expect(result.survivor.name).toBe('Alice');
    expect(result.mergedCount).toBe(2);
    expect(result.facesRepointed).toBe(2);

    // All three faces now resolve under the target.
    const detail = await getPerson(target._id);
    expect(detail?.faces.length).toBe(3);
    // Sources are tombstoned (getPerson returns null for merged rows).
    expect(await getPerson(srcA._id)).toBeNull();
    expect(await getPerson(srcB._id)).toBeNull();
  });

  it('skips self / already-merged / missing sources (idempotent)', async () => {
    if (!mongoReachable) return;
    const { createPerson, mergePeopleInto } = await import('./people.repo.ts');
    const target = await createPerson('Alice');
    const src = await createPerson('Person 1');

    // target listed as a source is skipped; src merges.
    const first = await mergePeopleInto(target._id, [src._id, target._id]);
    expect(first.mergedCount).toBe(1);

    // Re-merging the now-merged src + a random missing id is a no-op.
    const second = await mergePeopleInto(target._id, [src._id, new ObjectId()]);
    expect(second.mergedCount).toBe(0);
    expect(second.survivor._id.toHexString()).toBe(target._id.toHexString());
  });

  it('throws when the target is missing or already merged', async () => {
    if (!mongoReachable) return;
    const { createPerson, mergePeopleInto } = await import('./people.repo.ts');
    await expect(mergePeopleInto(new ObjectId(), [new ObjectId()])).rejects.toThrow(
      /person not found/,
    );
    // Merge a source into a target, then try to use that source as a new target.
    const target = await createPerson('Alice');
    const src = await createPerson('Person 1');
    await mergePeopleInto(target._id, [src._id]);
    await expect(mergePeopleInto(src._id, [target._id])).rejects.toThrow(/person already merged/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src/api && bun test src/people/people.repo.test.ts`
Expected: the three new tests FAIL with `mergePeopleInto is not a function` (or an import/type error). Existing tests still pass. (If Mongo is unreachable the whole file skip-passes — start a local `mongod` first.)

- [ ] **Step 3: Make `mergeInto` return its face count**

In `src/api/src/people/people.repo.ts`, change the `mergeInto` signature and add a return. Find:

```ts
async function mergeInto(survivor: ObjectId, orphan: ObjectId, name: string): Promise<void> {
```

Replace with:

```ts
async function mergeInto(
  survivor: ObjectId,
  orphan: ObjectId,
  name: string,
): Promise<{ facesRepointed: number }> {
```

Then at the very end of that function, after the `log.info({ … }, 'merged person');` call, add:

```ts
return { facesRepointed: repoint.modifiedCount };
```

(`renamePerson` already calls `await mergeInto(...)` without using the result, so it needs no change.)

- [ ] **Step 4: Add `MergePeopleResult` + `mergePeopleInto`**

In the same file, add the result interface next to `RenameResult` (near the top, after the `RenameResult` interface):

```ts
/** Result of `mergePeopleInto`. `mergedCount` is the number of sources that
 * were actually folded in (self / already-merged / missing sources are
 * skipped); `facesRepointed` is the total faces moved onto the survivor. */
export interface MergePeopleResult {
  survivor: PersonWithId;
  mergedCount: number;
  facesRepointed: number;
}
```

Then add the function right after `renamePerson` (before the `mergeInto` helper is fine — hoisted `async function` declarations are callable):

```ts
/**
 * Merge one or more source people INTO a target. Unlike rename-on-collision
 * (`renamePerson`), the TARGET is always the survivor — it keeps its `_id`,
 * `name`, cover, and `created_at`; every source's faces are repointed at the
 * target and each source row is marked `merged_into = target`. Reuses the same
 * `mergeInto` primitive the rename path uses, so the repoint/mark logic lives
 * in exactly one place.
 *
 * Sources equal to the target, already merged, or missing are skipped
 * (idempotent / defensive). Throws `person not found` / `person already merged`
 * for the target so the route can map them to 404 (mirrors `renamePerson`).
 */
export async function mergePeopleInto(
  targetId: ObjectId,
  sourceIds: ObjectId[],
): Promise<MergePeopleResult> {
  const coll = await peopleCollection();
  const target = await coll.findOne({ _id: targetId });
  if (!target) {
    throw new Error(`person not found: ${targetId.toHexString()}`);
  }
  if (target.merged_into) {
    throw new Error(`person already merged: ${targetId.toHexString()}`);
  }
  let mergedCount = 0;
  let facesRepointed = 0;
  for (const sourceId of sourceIds) {
    if (sourceId.equals(targetId)) continue;
    const source = await coll.findOne({ _id: sourceId });
    if (!source || source.merged_into) continue;
    // Target stays the survivor; pass its current name so the canonical name
    // is unchanged (no rename on an explicit merge).
    const { facesRepointed: n } = await mergeInto(targetId, sourceId, target.name);
    mergedCount += 1;
    facesRepointed += n;
  }
  const fresh = await coll.findOne({ _id: targetId });
  if (!fresh) throw new Error('target disappeared mid-merge');
  return { survivor: fresh as PersonWithId, mergedCount, facesRepointed };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src/api && bun test src/people/people.repo.test.ts`
Expected: all tests PASS (including the existing `renamePerson`/`listPeople`/`hidePerson` blocks).

- [ ] **Step 6: Commit**

```bash
git add src/api/src/people/people.repo.ts src/api/src/people/people.repo.test.ts
git commit -m "feat(api/people): mergePeopleInto — deterministic merge into a target (#1303)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Backend route — `POST /api/people/merge`

**Files:**

- Modify: `src/api/src/routes/people.ts`
- Test: `src/api/tests/people-route.test.ts`

- [ ] **Step 1: Write the failing tests**

Append this `describe` block at the top level of `src/api/tests/people-route.test.ts`. It uses the file's existing helpers: `post(path, body)` / `get(path)` (both return `{ status, body }`), `insertAssetWithFaces(faces)`, `mongoReachable`, `ObjectId`, and `createPerson` (imported dynamically as elsewhere in the file). `AssetFaceDoc` is already imported at the top of the file.

```ts
describe('POST /api/people/merge', () => {
  it('folds sources into the target and returns counts', async () => {
    if (!mongoReachable) return;
    const { createPerson } = await import('../src/people/people.repo.ts');
    const target = await createPerson('Alice');
    const src = await createPerson('Person 1');
    await insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 10, h: 10 }, person_id: src._id.toHexString(), confidence: 0.9 },
    ]);

    const r = await post('/api/people/merge', {
      target_id: target._id.toHexString(),
      source_ids: [src._id.toHexString()],
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      id: string;
      name: string;
      merged_count: number;
      faces_repointed: number;
    };
    expect(body.id).toBe(target._id.toHexString());
    expect(body.name).toBe('Alice');
    expect(body.merged_count).toBe(1);
    expect(body.faces_repointed).toBe(1);

    // Source is now unreachable (tombstoned → getPerson returns 404).
    const gone = await get(`/api/people/${src._id.toHexString()}`);
    expect(gone.status).toBe(404);
  });

  it('400s on an invalid target id', async () => {
    if (!mongoReachable) return;
    const r = await post('/api/people/merge', {
      target_id: 'not-an-id',
      source_ids: ['0123456789abcdef01234567'],
    });
    expect(r.status).toBe(400);
  });

  it('404s on an unknown target', async () => {
    if (!mongoReachable) return;
    const r = await post('/api/people/merge', {
      target_id: new ObjectId().toHexString(),
      source_ids: [new ObjectId().toHexString()],
    });
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src/api && bun test tests/people-route.test.ts`
Expected: new tests FAIL — the merge route 404s (route not found) or the happy-path assertion fails.

- [ ] **Step 3: Import `mergePeopleInto` into the route file**

In `src/api/src/routes/people.ts`, add `mergePeopleInto` to the existing import from `../people/people.repo.ts`:

```ts
import {
  assignFaceToPerson,
  createPerson,
  getPerson,
  hideFace,
  hidePerson,
  listHiddenPeople,
  listPeople,
  mergePeopleInto,
  renamePerson,
  unhidePerson,
  type PersonWithCount,
} from '../people/people.repo.ts';
```

- [ ] **Step 4: Add the `MergeBody` schema**

Next to the other `t.Object` body schemas near the top of the file, add:

```ts
const MergeBody = t.Object({
  target_id: t.String({ minLength: 1 }),
  source_ids: t.Array(t.String({ minLength: 1 }), { minItems: 1 }),
});
```

- [ ] **Step 5: Add the route**

Insert this `.post('/merge', …)` into the route chain, immediately after the rename `.put('/:id', …)` block (before the `/:id/hide` block). `POST /merge` is a distinct literal — no clash with the `:id` param routes (there is no `POST /:id`).

```ts
  // ── Explicit merge: fold source people INTO a target (target survives) ──
  // Unlike rename-on-collision, the chosen target is always the survivor — it
  // keeps its id, cover, and created_at. Backs the list bulk-merge toolbar and
  // the detail "Merge into…" button.
  .post(
    '/merge',
    async ({ body, set }) => {
      const targetId = safeObjectId(body.target_id);
      if (!targetId) {
        set.status = 400;
        return { error: 'invalid target_id' };
      }
      // Parse + de-dupe source ids; drop invalid ones and the target itself.
      const seen = new Set<string>();
      const sourceIds: ObjectId[] = [];
      for (const raw of body.source_ids) {
        const oid = safeObjectId(raw);
        if (!oid) continue;
        const hex = oid.toHexString();
        if (hex === targetId.toHexString() || seen.has(hex)) continue;
        seen.add(hex);
        sourceIds.push(oid);
      }
      if (sourceIds.length === 0) {
        set.status = 400;
        return { error: 'no valid source_ids to merge' };
      }
      try {
        const result = await mergePeopleInto(targetId, sourceIds);
        return {
          id: result.survivor._id.toHexString(),
          name: result.survivor.name,
          merged_count: result.mergedCount,
          faces_repointed: result.facesRepointed,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('person not found') || msg.startsWith('person already merged')) {
          set.status = 404;
          return { error: msg };
        }
        log.error({ err: msg }, 'merge failed');
        set.status = 500;
        return { error: msg };
      }
    },
    { body: MergeBody },
  )
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd src/api && bun test tests/people-route.test.ts`
Expected: all three new tests PASS; existing route tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src/api/src/routes/people.ts src/api/tests/people-route.test.ts
git commit -m "feat(api/people): POST /api/people/merge route (#1303)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Web API client — `mergePeople` + `ApiMergeResult`

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/api/bun-api-backend.service.ts`

No dedicated unit test (this is a thin snake→camel HTTP map, matching the un-unit-tested `renamePerson`/`hidePerson` methods next to it); covered by the route test + the verification walkthrough in Task 8.

- [ ] **Step 1: Add the `ApiMergeResult` type**

After the `ApiRenameResult` interface (near the other `ApiPerson*` result types), add:

```ts
/** Result of POST /api/people/merge (camel-cased). */
export interface ApiMergeResult {
  id: string;
  name: string;
  mergedCount: number;
}
```

And after `ApiRenameResultRaw` (with the other `*Raw` interfaces), add:

```ts
interface ApiMergeResultRaw {
  id: string;
  name: string;
  merged_count: number;
}
```

- [ ] **Step 2: Add the `mergePeople` method**

In the `BunApiBackendService` class, immediately after the `renamePerson` method, add:

```ts
  /** Merge source people INTO a target — the target survives (keeps id /
   * cover / created_at). Returns the survivor + counts. */
  mergePeople(targetId: string, sourceIds: string[]): Observable<ApiMergeResult> {
    return this.http
      .post<ApiMergeResultRaw>(`${this.base}/people/merge`, {
        target_id: targetId,
        source_ids: sourceIds,
      })
      .pipe(
        map((r) => ({
          id: r.id,
          name: r.name,
          mergedCount: r.merged_count,
        })),
      );
  }
```

- [ ] **Step 3: Typecheck**

Run: `cd src/web && bun x tsc -p projects/maple-common/tsconfig.lib.json --noEmit`
Expected: no new errors referencing `mergePeople` / `ApiMergeResult`. (If this tsconfig path doesn't exist, defer to the Task 8 `ng build` typecheck.)

- [ ] **Step 4: Commit**

```bash
git add src/web/projects/maple-common/src/lib/api/bun-api-backend.service.ts
git commit -m "feat(web/api): mergePeople client method + ApiMergeResult (#1303)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Web store — `mergePeople`, `hidePeople`, shared eviction tail

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/api/people.store.ts`

- [ ] **Step 1: Import `ApiMergeResult`**

Extend the existing type import from the service:

```ts
import {
  BunApiBackendService,
  type ApiMergeResult,
  type ApiPerson,
  type ApiPersonDetail,
} from './bun-api-backend.service';
```

- [ ] **Step 2: Add a shared eviction/refresh tail and route hide/unhide through it**

In the `PeopleStore` class, in the "Mutation pass-throughs" section, add the shared private helper and refactor `hidePerson` + `unhidePerson` to use it:

```ts
  /** Evict the given details, then refresh BOTH the main and hidden lists
   * once. Shared by every people mutation that can move rows between the two
   * lists (hide / unhide / merge) so the cache bookkeeping lives in one place. */
  private _evictAndRefreshLists(ids: string[]): void {
    ids.forEach((id) => this.evictDetail(id));
    this.invalidate();
    this.invalidateHidden();
  }

  /** Soft-hide a person server-side, then evict + refresh both lists. Throws
   * on failure so the caller can surface an error toast. */
  async hidePerson(id: string): Promise<void> {
    await firstValueFrom(this.api.hidePerson(id));
    this._evictAndRefreshLists([id]);
  }

  /** Restore a hidden person, then evict + refresh both lists. Throws on failure. */
  async unhidePerson(id: string): Promise<void> {
    await firstValueFrom(this.api.unhidePerson(id));
    this._evictAndRefreshLists([id]);
  }
```

Replace the existing `hidePerson` and `unhidePerson` method bodies with the versions above (delete the old inline `evictDetail` + `invalidate` + `invalidateHidden` lines they contained).

- [ ] **Step 3: Add `mergePeople` + `hidePeople`**

Add these two methods after `unhidePerson`:

```ts
  /** Merge source people into a target (target survives). Evicts the now-
   * tombstoned sources, refreshes both lists, and refreshes the survivor's
   * detail. Throws on failure. Returns the survivor + counts for the toast. */
  async mergePeople(targetId: string, sourceIds: string[]): Promise<ApiMergeResult> {
    const result = await firstValueFrom(this.api.mergePeople(targetId, sourceIds));
    this._evictAndRefreshLists(sourceIds);
    this.invalidateDetail(targetId);
    return result;
  }

  /** Bulk soft-hide. Fans out the per-person hide in parallel (allSettled so a
   * single failure doesn't abort the batch), then evicts + refreshes both
   * lists once. Returns ok/failed counts for the toast. */
  async hidePeople(ids: string[]): Promise<{ ok: number; failed: number }> {
    const results = await Promise.allSettled(
      ids.map((id) => firstValueFrom(this.api.hidePerson(id))),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    this._evictAndRefreshLists(ids);
    return { ok, failed: ids.length - ok };
  }
```

- [ ] **Step 4: Commit**

```bash
git add src/web/projects/maple-common/src/lib/api/people.store.ts
git commit -m "feat(web/people): store mergePeople + hidePeople + shared eviction tail (#1303)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: VM helpers — `toggleKey`, `mergeTargets`, confirm copy (+ refactor `toggleSelection`)

**Files:**

- Modify: `src/web/projects/maple/src/app/settings/people/people.vm.ts`
- Test: `src/web/projects/maple/src/app/settings/people/people.vm.spec.ts`

- [ ] **Step 1: Write the failing tests**

Add these imports to the existing import block at the top of `people.vm.spec.ts` (alongside the other `./people.vm` imports):

```ts
import { toggleKey, mergeTargets, mergePeopleConfirm, hidePeopleConfirm } from './people.vm';
```

Append these `describe` blocks at the end of the file:

```ts
describe('toggleKey', () => {
  it('adds a missing key and removes a present one, immutably', () => {
    const a = toggleKey(new Set<string>(), 'x');
    expect([...a]).toEqual(['x']);
    const b = toggleKey(a, 'x');
    expect([...b]).toEqual([]);
    expect([...a]).toEqual(['x']); // original set untouched
  });
});

describe('mergeTargets', () => {
  const mk = (id: string, name: string): ApiPerson => ({
    id,
    name,
    faceCount: 0,
    coverAssetId: null,
    coverAbsPath: null,
    coverBbox: null,
    createdAt: '',
    updatedAt: '',
  });
  it('returns named people minus the excluded ids', () => {
    const named = [mk('1', 'Alice'), mk('2', 'Bob'), mk('3', 'Cara')];
    const out = mergeTargets(named, new Set(['2']));
    expect(out.map((p) => p.id)).toEqual(['1', '3']);
  });
});

describe('mergePeopleConfirm / hidePeopleConfirm', () => {
  it('pluralises the subject count', () => {
    expect(mergePeopleConfirm(1, 'Alice')).toContain('1 person into "Alice"');
    expect(mergePeopleConfirm(3, 'Alice')).toContain('3 people into "Alice"');
    expect(hidePeopleConfirm(1)).toContain('Hide 1 person');
    expect(hidePeopleConfirm(2)).toContain('Hide 2 people');
  });
});
```

(`ApiPerson` is already imported at the top of the spec.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src/web && bun run test -- people.vm`
Expected: FAIL — `toggleKey`/`mergeTargets`/`mergePeopleConfirm`/`hidePeopleConfirm` are not exported. (If the `-- people.vm` filter isn't supported by the runner, run `bun run test` and look at the `people.vm.spec` results.)

- [ ] **Step 3: Add `toggleKey` and refactor `toggleSelection`**

In `people.vm.ts`, in the "Face-selection plumbing" section, add `toggleKey` just above `toggleSelection`, and rewrite `toggleSelection` to delegate:

```ts
/** Toggle a single key in / out of a selection set. Returns a NEW `Set` —
 * never mutates the input. The one immutable add/remove primitive behind both
 * face selection (keyed by `faceKey`) and people selection (keyed by id). */
export function toggleKey(selection: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selection);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Toggle a single face key in / out of a selection set. Thin wrapper over
 * {@link toggleKey}. */
export function toggleSelection(
  selection: ReadonlySet<string>,
  face: { assetId: string; faceIndex: number },
): Set<string> {
  return toggleKey(selection, faceKey(face));
}
```

Delete the previous `toggleSelection` body (the inline `const key = faceKey(face); const next = new Set(...)` version).

- [ ] **Step 4: Add `mergeTargets`**

In the "List-view derivation" section, right after `filterNamed`, add:

```ts
/** Merge-target candidates: named people minus the given ids (the currently-
 * selected people, or the open person on the detail page). Feeds both the list
 * bulk-merge `<select>` and the detail "Merge into…" picker. */
export function mergeTargets(
  named: readonly ApiPerson[],
  excludeIds: ReadonlySet<string>,
): ApiPerson[] {
  return named.filter((p) => !excludeIds.has(p.id));
}
```

- [ ] **Step 5: Add the confirm copy**

In the "Copy / labels" section, right after `hidePersonConfirm`, add:

```ts
/** Confirm-prompt body for bulk soft-hide from the list toolbar. Pluralises
 * "person"/"people" honestly. Soft action — rows move to the Hidden page. */
export function hidePeopleConfirm(count: number): string {
  return `Hide ${count} ${count === 1 ? 'person' : 'people'}? They'll move to the Hidden page; their photos stay grouped and you can restore them anytime.`;
}

/** Confirm-prompt body for a bulk / explicit merge. The target survives; the
 * merged people's faces are reassigned to it. Pluralises honestly. */
export function mergePeopleConfirm(count: number, targetName: string): string {
  const noun = count === 1 ? 'person' : 'people';
  return `Merge ${count} ${noun} into "${targetName}"? Their faces will be reassigned to "${targetName}" and the merged ${noun} will disappear from the list.`;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd src/web && bun run test -- people.vm`
Expected: all `people.vm.spec` tests PASS (new blocks + the existing `toggleSelection`-dependent tests still green).

- [ ] **Step 7: Commit**

```bash
git add src/web/projects/maple/src/app/settings/people/people.vm.ts src/web/projects/maple/src/app/settings/people/people.vm.spec.ts
git commit -m "feat(web/people): toggleKey + mergeTargets + bulk confirm copy (#1303)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: List page — select mode + bulk toolbar

**Files:**

- Modify: `src/web/projects/maple/src/app/settings/people/people.component.ts`
- Modify: `src/web/projects/maple/src/app/settings/people/people.component.html`
- Modify: `src/web/projects/maple/src/app/settings/people/people.component.scss`

- [ ] **Step 1: Extend the VM imports in the component**

In `people.component.ts`, add the four new helpers to the existing `import { … } from './people.vm';` block:

```ts
  hidePeopleConfirm,
  mergePeopleConfirm,
  mergeTargets,
  toggleKey,
```

(Insert each in the appropriate alphabetical position within that import list.)

- [ ] **Step 2: Add list-selection state + actions to the component**

In `people.component.ts`, add the following members to the `PeopleComponent` class. Put them after the existing `namedPeople` computed (around line 173) so `namedPeople` is in scope:

```ts
  // ── List-view people selection (bulk hide / merge) ──────────────────
  /** When true, list cards toggle selection instead of navigating. */
  readonly selectMode = signal<boolean>(false);
  /** Selected person ids for the bulk toolbar. */
  readonly selectedPeople = signal<ReadonlySet<string>>(new Set());
  /** In-flight count for a bulk people op — disables the toolbar while > 0. */
  readonly peopleBulkBusy = signal<number>(0);

  /** Named-people merge targets for the list toolbar, excluding the current
   * selection (you can't merge people into one of themselves). */
  readonly mergeTargetsList = computed(() =>
    mergeTargets(this.namedPeople(), this.selectedPeople()),
  );

  enterSelectMode(): void {
    this.selectMode.set(true);
  }

  exitSelectMode(): void {
    this.selectMode.set(false);
    this.selectedPeople.set(new Set());
  }

  isPersonSelected(id: string): boolean {
    return this.selectedPeople().has(id);
  }

  togglePersonSelection(id: string): void {
    this.selectedPeople.set(toggleKey(this.selectedPeople(), id));
  }

  private clearPeopleSelection(): void {
    this.selectedPeople.set(new Set());
  }

  /** Shared merge flow for the list toolbar AND the detail button. Confirms,
   * calls the store, toasts the result, then runs `after` (list: clear +
   * stay in select mode; detail: navigate to the target). */
  private async performMerge(
    targetId: string,
    sourceIds: string[],
    after: () => void,
  ): Promise<void> {
    if (!targetId || sourceIds.length === 0) return;
    const targetName = this.people().find((p) => p.id === targetId)?.name ?? 'person';
    if (!confirm(mergePeopleConfirm(sourceIds.length, targetName))) return;
    this.peopleBulkBusy.update((n) => n + 1);
    try {
      const result = await this.store.mergePeople(targetId, sourceIds);
      this.showToast(`Merged ${result.mergedCount} into ${result.name}`, 'success');
      after();
    } catch (err) {
      this.showToast(errorMessage(err), 'error');
    } finally {
      this.peopleBulkBusy.update((n) => Math.max(0, n - 1));
    }
  }

  mergeSelectedInto(targetId: string): void {
    void this.performMerge(targetId, [...this.selectedPeople()], () =>
      this.clearPeopleSelection(),
    );
  }

  async hideSelectedPeople(): Promise<void> {
    const ids = [...this.selectedPeople()];
    if (ids.length === 0) return;
    if (!confirm(hidePeopleConfirm(ids.length))) return;
    this.peopleBulkBusy.update((n) => n + 1);
    try {
      const { ok, failed } = await this.store.hidePeople(ids);
      if (ok > 0) this.showToast(`Hid ${ok} ${ok === 1 ? 'person' : 'people'}`, 'success');
      if (failed > 0) this.showToast(`${failed} failed to hide`, 'error');
      this.clearPeopleSelection();
    } catch (err) {
      this.showToast(errorMessage(err), 'error');
    } finally {
      this.peopleBulkBusy.update((n) => Math.max(0, n - 1));
    }
  }
```

- [ ] **Step 3: Add the "Select"/"Done" toggle to the list header**

In `people.component.html`, in the list-view `<div class="actions">` block (currently containing the Hidden link, Worker settings link, and Run clustering button — around line 281), add the toggle as the first child:

```html
<div class="actions">
  @if (selectMode()) {
  <button
    type="button"
    class="btn-ghost"
    (click)="exitSelectMode()"
    aria-label="Exit selection mode"
  >
    Done
  </button>
  } @else {
  <button
    type="button"
    class="btn-ghost"
    (click)="enterSelectMode()"
    aria-label="Select people for bulk actions"
  >
    Select
  </button>
  }
  <a class="btn-ghost" routerLink="/settings/people/hidden">Hidden</a>
  <a class="btn-ghost" routerLink="/settings/workers">Worker settings</a>
  <button type="button" class="btn-primary" [disabled]="clusteringBusy()" (click)="runClustering()">
    <maple-settings-icon name="sparkle" [size]="13" color="#ffffff" />
    {{ clusteringBusy() ? 'Clustering…' : 'Run clustering' }}
  </button>
</div>
```

- [ ] **Step 4: Make cards toggle selection in select mode**

In `people.component.html`, replace the opening `<article class="person-card" …>` tag (around line 332) and add the check indicator inside `.person-thumb`. Replace the `<article …>` opening tag with:

```html
<article
  class="person-card"
  [class.is-selectable]="selectMode()"
  [class.is-selected]="selectMode() && isPersonSelected(p.id)"
  [style.width.px]="cardWidth()"
  (click)="selectMode() ? togglePersonSelection(p.id) : selectPerson(p.id)"
  (mapleVisibleOnce)="ensureCoverThumb(p)"
  tabindex="0"
  role="button"
  [attr.aria-pressed]="selectMode() ? isPersonSelected(p.id) : null"
  [attr.aria-label]="selectMode() ? 'Select ' + p.name : null"
  (keydown.enter)="
                    selectMode() ? togglePersonSelection(p.id) : selectPerson(p.id);
                    $event.preventDefault()
                  "
  (keydown.space)="
                    selectMode() ? togglePersonSelection(p.id) : selectPerson(p.id);
                    $event.preventDefault()
                  "
></article>
```

Then, immediately inside `<div class="person-thumb">` (as its first child, before the cover `@if`), add the reused check chip:

```html
@if (selectMode()) {
<span class="select-check" [class.is-selected]="isPersonSelected(p.id)">
  @if (isPersonSelected(p.id)) {
  <maple-settings-icon name="check" [size]="12" color="#ffffff" [stroke]="2.4" />
  }
</span>
}
```

- [ ] **Step 5: Hide the per-card "Hide" button in select mode**

In the same card, wrap the existing per-card Hide `<button class="card-delete" …>` (around line 377) in a guard:

```html
@if (!selectMode()) {
<button
  type="button"
  class="card-delete"
  [title]="'Hide ' + p.name"
  (click)="$event.stopPropagation(); hidePerson(p)"
>
  Hide
</button>
}
```

- [ ] **Step 6: Add the list bulk toolbar**

In `people.component.html`, add this block inside the list-view `<div class="people-list-view">`, immediately after the closing `</div>` of `<div class="people-body">` (still inside `.people-list-view`). It reuses the existing `.bulk-toolbar-wrap` / `.bulk-toolbar` styles:

```html
@if (selectMode() && selectedPeople().size > 0) {
<div class="bulk-toolbar-wrap">
  <div class="bulk-toolbar">
    <span class="bulk-count">{{ selectedPeople().size }} selected</span>
    <div class="bulk-sep"></div>

    <label class="bulk-btn">
      <maple-settings-icon name="merge" [size]="13" color="#f5f4f2" />
      <span>Merge into…</span>
      <select
        class="bulk-select"
        [disabled]="peopleBulkBusy() > 0 || mergeTargetsList().length === 0"
        aria-label="Merge selected people into"
        (change)="mergeSelectedInto($any($event.target).value); $any($event.target).value = ''"
      >
        <option value="">…</option>
        @for (t of mergeTargetsList(); track t.id) {
        <option [value]="t.id">{{ t.name }}</option>
        }
      </select>
    </label>

    <button
      type="button"
      class="bulk-btn"
      [disabled]="peopleBulkBusy() > 0"
      (click)="hideSelectedPeople()"
    >
      <maple-settings-icon name="eye" [size]="13" color="#f5f4f2" />
      Hide
    </button>
    <div class="bulk-sep"></div>
    <button type="button" class="bulk-btn mute" (click)="exitSelectMode()">
      <maple-settings-icon name="x" [size]="13" color="#a8a29e" />
      Cancel
    </button>
  </div>
</div>
}
```

- [ ] **Step 7: Add minimal selected-card styling**

In `people.component.scss`, append:

```scss
// ── List-view select mode ───────────────────────────────────────────
.person-card.is-selectable {
  cursor: pointer;
}

.person-card.is-selected {
  outline: 2px solid #6ea8fe;
  outline-offset: 2px;
  border-radius: 8px;
}

// The `.select-check` chip (reused from the face grid) is absolutely
// positioned, so the thumb must establish a positioning context.
.person-thumb {
  position: relative;
}
```

> If `.person-thumb` already declares `position: relative` in this file, omit that rule to avoid a duplicate (the cascade tolerates it either way).

- [ ] **Step 8: Build to verify it typechecks and compiles**

Run: `cd src/web && bun x ng build maple`
Expected: build succeeds with no template/TS errors. (Do not pipe the output through `tail`.)

- [ ] **Step 9: Commit**

```bash
git add src/web/projects/maple/src/app/settings/people/people.component.ts src/web/projects/maple/src/app/settings/people/people.component.html src/web/projects/maple/src/app/settings/people/people.component.scss
git commit -m "feat(web/people): list multi-select mode + bulk hide/merge toolbar (#1303)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Person page — "Merge into…" picker → navigate to target

**Files:**

- Modify: `src/web/projects/maple/src/app/settings/people/people.component.ts`
- Modify: `src/web/projects/maple/src/app/settings/people/people.component.html`

- [ ] **Step 1: Add detail merge-picker state + commit, remove `triggerMerge`**

In `people.component.ts`, add these members (near `performMerge` from Task 6):

```ts
  // ── Detail-view "Merge into…" picker ────────────────────────────────
  /** Whether the detail header is showing the merge-target `<select>`. */
  readonly mergePickerOpen = signal<boolean>(false);

  /** Named-people targets for the detail merge, excluding the open person. */
  readonly detailMergeTargets = computed(() => {
    const detail = this.selected();
    const exclude = new Set<string>(detail ? [detail.id] : []);
    return mergeTargets(this.namedPeople(), exclude);
  });

  openMergePicker(): void {
    this.mergePickerOpen.set(true);
  }

  cancelMergePicker(): void {
    this.mergePickerOpen.set(false);
  }

  /** Merge the open person INTO the picked target, then navigate to the
   * target's detail page (it now shows the combined faces). */
  mergeDetailInto(targetId: string): void {
    const detail = this.selected();
    if (!detail || !targetId) return;
    this.mergePickerOpen.set(false);
    void this.performMerge(targetId, [detail.id], () => {
      void this.router.navigate(['/settings/people', targetId]);
    });
  }
```

Then DELETE the now-unused `triggerMerge()` method (the one that calls `startEdit(detail)` — around line 406). The name-click rename flow (`startEdit`/`commitEdit`) stays untouched.

- [ ] **Step 2: Replace the detail "Merge into…" button with the picker**

In `people.component.html`, replace the `<div class="detail-actions">` block (around line 98) with:

Reuse the existing `.btn-ghost` class on the `<select>` (no new SCSS — keeps it visually consistent with the other detail-action controls):

```html
<div class="detail-actions">
  @if (mergePickerOpen()) {
  <select
    class="btn-ghost merge-select"
    [disabled]="peopleBulkBusy() > 0 || detailMergeTargets().length === 0"
    aria-label="Merge this person into"
    (change)="mergeDetailInto($any($event.target).value)"
  >
    <option value="">Merge into…</option>
    @for (t of detailMergeTargets(); track t.id) {
    <option [value]="t.id">{{ t.name }}</option>
    }
  </select>
  <button type="button" class="btn-ghost" (click)="cancelMergePicker()">Cancel</button>
  } @else {
  <button
    type="button"
    class="btn-ghost"
    [disabled]="detailMergeTargets().length === 0"
    (click)="openMergePicker()"
  >
    <maple-settings-icon name="merge" [size]="12" />
    Merge into…
  </button>
  }
  <button type="button" class="btn-ghost danger" (click)="hideSelectedCluster()">
    Hide person
  </button>
</div>
```

- [ ] **Step 3: Build to verify**

Run: `cd src/web && bun x ng build maple`
Expected: build succeeds with no template/TS errors.

- [ ] **Step 4: Commit**

```bash
git add src/web/projects/maple/src/app/settings/people/people.component.ts src/web/projects/maple/src/app/settings/people/people.component.html
git commit -m "feat(web/people): detail Merge into… picker navigates to the target (#1303)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Full verification + format gate

**Files:** none (verification only).

- [ ] **Step 1: API tests**

Run: `cd src/api && bun test src/people/people.repo.test.ts tests/people-route.test.ts`
Expected: PASS (or skip-pass with a "MongoDB unreachable" log if no local Mongo). Start a local `mongod` on :27017 first if you want real coverage.

- [ ] **Step 2: Web VM tests**

Run: `cd src/web && bun run test -- people.vm`
Expected: `people.vm.spec` PASS. (A pre-existing unrelated red spec elsewhere in the suite is not introduced by this work — confirm the people specs specifically are green.)

- [ ] **Step 3: Web build (typecheck + template compile)**

Run: `cd src/web && bun x ng build maple`
Expected: build succeeds.

- [ ] **Step 4: Manual walkthrough (dev server)**

Start: `cd src/web && bun x ng serve maple` (http://localhost:4200, or :4201 in a fresh worktree). With the API + a library that has clustered faces:

- `/settings/people` → click **Select** → cards show a check chip and toggle on click (no navigation). The per-card "Hide" is gone in select mode.
- Select 2+ people → floating toolbar shows "N selected", "Merge into…", "Hide", "Cancel".
- **Merge into…** a named person → confirm → toast "Merged N into <name>"; the merged cards leave the list, the target's count grows, you **stay** in select mode.
- Select more → **Hide** → confirm → toast "Hid N people"; they leave the list (and appear under **Hidden**).
- Open a person → header **Merge into…** → pick a named target → confirm → you land on the **target's** detail page showing the combined faces.

- [ ] **Step 5: Format gate**

Run: `cd src/web && bun run format` then `cd src/web && bun run format:check`
Expected: `format:check` passes. (Prettier is the only web style gate; it runs over the branch diff vs `origin/main`, so new files are covered.)

- [ ] **Step 6: Final commit (only if format changed files)**

```bash
git add -A
git commit -m "style(web/people): prettier format pass (#1303)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes (for the implementer)

- **Survivor semantics:** `mergePeopleInto` always keeps the **target**. Rename-on-collision (`renamePerson`) is intentionally left on its older-`_id` rule — do not "unify" them; they're different intents (Task scope boundary from the spec).
- **DRY anchors:** `mergeInto` is the single repoint/mark primitive; `toggleKey` underlies both face and people selection; `mergeTargets` feeds both pickers; `performMerge` is shared by list + detail; `_evictAndRefreshLists` is the single hide/unhide/merge cache tail.
- **a11y:** Select toggle, selectable cards (`role=button` + `aria-pressed` + `aria-label`), and every toolbar control have labels.
- **No deletion:** "Hide" is soft-hide only (rows + faces preserved). No code path deletes assets or people rows.

```

```
