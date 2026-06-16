# People: multi-select → bulk hide / merge

Date: 2026-06-15
Status: Approved design — ready for implementation plan

## Summary

Add an operator multi-select mode to the People list (`/settings/people`) with a
toolbar to **hide** the selected people and **merge** them into a chosen target
person. Make the existing person-detail "Merge into…" action a deterministic
merge that navigates to the target, showing the combined face set.

Two flows, one merge primitive:

- **List** (`/settings/people`): a "Select" toggle puts cards into selection
  mode; a floating toolbar offers "Merge into…" (named-person picker) and
  "Hide". After a bulk merge you **stay on the list** in select mode (keep
  working through groups).
- **Detail** (`/settings/people/:id`): "Merge into…" merges this person into the
  picked target and **navigates to the target's detail page**.

## Goals

- Select N people in the list and hide them in one action.
- Select N people in the list and merge them into one named target in one action.
- "Merge into…" on the detail page lands on the target person showing the merged
  faces.
- The chosen merge target **deterministically survives**, keeping its id, cover
  photo, and `created_at`.
- Reuse existing primitives (merge logic, soft-hide, toolbar styling, selection
  helpers) — no parallel reimplementations.

## Non-goals / out of scope

- Changing the **rename-on-collision** merge (clicking a name and typing an
  existing name). It keeps its current behaviour (survivor = older `_id`). Only
  the explicit "Merge into…" action and the new bulk merge use target-survives.
- An unmerge / merge-history UI (the `merged_into` audit trail already records
  direction; surfacing it is a separate ticket).
- Any deletion of assets or originals. "Hide" is the existing **soft-hide**
  (row + faces preserved, stays a clustering seed).
- Bulk rename / bulk unhide.

## Current state (what already exists)

- **Merge logic**: `mergeInto(survivor, orphan, name)` in
  `src/api/src/people/people.repo.ts` — repoints `asset.faces[].person_id` from
  orphan → survivor, marks orphan `merged_into = survivor`, canonicalises the
  survivor name, forces a centroid recompute. It already computes
  `repoint.modifiedCount`.
- **Merge entry point**: `renamePerson` (`PUT /api/people/:id`) — merges only on
  a _name collision_ and picks the survivor by **older `_id`**. Wrong policy for
  "merge into target": a source with an older `_id` would make the target the
  tombstone (its id 404s via `getPerson`'s `merged_into` guard) and the merged
  person would inherit the _source's_ cover (mergeInto copies only the name).
- **Soft-hide**: `hidePerson(id)` (`POST /api/people/:id/hide`) + store
  `hidePerson` (evict detail, invalidate main + hidden lists). Per-card "Hide"
  button already wired.
- **Selection + toolbar pattern**: the detail face grid already has
  `selectedFaces` (a `ReadonlySet<string>`), `toggleSelection`/`selectAllKeys`
  in `people.vm.ts`, and a floating `.bulk-toolbar` (with a "Move to person…"
  `<select>`) in `people.component.html`. The list bulk UI reuses this pattern
  and CSS.

## Backend (`src/api`) — thin reuse of `mergeInto`

No new merge logic; a deterministic entry point over the existing helper.

### `people.repo.ts`

1. **`mergeInto` returns its face count.** Change the signature from
   `Promise<void>` to `Promise<{ facesRepointed: number }>`, returning the
   already-computed `repoint.modifiedCount`. `renamePerson` ignores the value;
   `mergePeopleInto` sums it. (Single source of the repoint count.)

2. **New `mergePeopleInto(targetId, sourceIds[])`**:

   ```ts
   export interface MergePeopleResult {
     survivor: PersonWithId;
     mergedCount: number; // sources actually merged
     facesRepointed: number; // summed across merges
   }

   export async function mergePeopleInto(
     targetId: ObjectId,
     sourceIds: ObjectId[],
   ): Promise<MergePeopleResult>;
   ```

   - Load the target; throw `person not found` / `person already merged` (the
     route maps these to 404, matching `renamePerson`'s error contract).
   - For each source: skip if it equals the target, is missing, or is already
     merged (idempotent / defensive). Otherwise
     `await mergeInto(targetId, sourceId, target.name)` — target stays the
     survivor, name unchanged. Accumulate `mergedCount` + `facesRepointed`.
   - Re-fetch and return the survivor (its `updated_at` moved).
   - Looping the existing helper keeps the repoint/mark logic in exactly one
     place. Selection sizes are small (operator consolidating a handful), so the
     per-source `updateMany` loop is fine; if a future batch is large this can
     become a single `$in` updateMany without changing the contract.

### `routes/people.ts`

New route (literal `POST /api/people/merge` — no clash with `/:id`):

```ts
const MergeBody = t.Object({
  target_id: t.String({ minLength: 1 }),
  source_ids: t.Array(t.String({ minLength: 1 }), { minItems: 1 }),
});
```

- `safeObjectId` the target → 400 on invalid. Parse source ids, dropping invalid
  / duplicate ones and the target id itself.
- Call `mergePeopleInto`; map `person not found` / `person already merged` →
  404, other errors → 500 (mirror `renamePerson`).
- Response: `{ id, name, merged_count, faces_repointed }`.

## Web data layer (`maple-common`)

### `bun-api-backend.service.ts`

```ts
export interface ApiMergeResult {
  id: string;
  name: string;
  mergedCount: number;
  facesRepointed: number;
}

mergePeople(targetId: string, sourceIds: string[]): Observable<ApiMergeResult>
// POST /people/merge { target_id, source_ids } → map snake→camel
```

### `people.store.ts`

- **`mergePeople(targetId, sourceIds): Promise<ApiMergeResult>`** — await the API
  call, then `sourceIds.forEach(evictDetail)`, `invalidate()` (list),
  `invalidateDetail(targetId)`, `invalidateHidden()`. Reuses existing cache
  primitives. Throws on failure for the caller's error toast.
- **`hidePeople(ids[]): Promise<{ ok: number; failed: number }>`** —
  `Promise.allSettled(ids.map(id => firstValueFrom(this.api.hidePerson(id))))`,
  evict each detail, then invalidate both lists **once**. Returns counts for the
  toast.
- **DRY tail**: extract a private `_invalidateAfterHide(ids)` (evict each +
  `invalidate()` + `invalidateHidden()`); both `hidePerson` (single, throws) and
  `hidePeople` (bulk, counts) call it. No duplicated cache bookkeeping.

## List page — `people.component.ts` / `.html` / `.scss`

### State

```ts
readonly selectMode = signal<boolean>(false);
readonly selectedPeople = signal<ReadonlySet<string>>(new Set()); // person ids
readonly peopleBulkBusy = signal<number>(0);
```

### Header

Add a **"Select"** toggle button in `.actions`. Active → label "Done", calls
`exitSelectMode()` (sets `selectMode=false`, clears `selectedPeople`).
`enterSelectMode()` sets `selectMode=true`.

### Card behaviour (select mode only)

- Card click → `togglePersonSelection(p.id)` instead of `selectPerson(p.id)`.
- Reuse the `.select-check` indicator + `[class.is-selected]` + `aria-pressed`.
- Suppress the per-card "Hide" button while selecting (bulk Hide covers it).
- Out of select mode: unchanged (click navigates).

### Floating toolbar

Reuse `.bulk-toolbar-wrap` / `.bulk-toolbar`. Shown when
`selectMode() && selectedPeople().size > 0`:

- `"{n} selected"`.
- **"Merge into…"** `<select>` over `mergeTargets(namedPeople(), selectedPeople())`
  (named people, excluding the selected). Disabled while
  `peopleBulkBusy() > 0` or the target list is empty. On change →
  `mergeSelectedInto(targetId)`.
- **"Hide"** → `hideSelectedPeople()`.
- **"Cancel"** → `exitSelectMode()`.

### Actions

- `mergeSelectedInto(targetId)` → `performMerge(targetId, [...selectedPeople()],
() => this.clearPeopleSelection())` (stays in select mode).
- `hideSelectedPeople()` → confirm `hidePeopleConfirm(n)`; `peopleBulkBusy++`;
  `await store.hidePeople(ids)`; toast ok/failed; clear selection; stay in
  select mode; `peopleBulkBusy--`.

## Person page — `people.component.ts` / `.html`

Repoint the existing **"Merge into…"** button from the rename flow to an explicit
merge:

- Clicking it reveals an inline `<select>` over
  `mergeTargets(namedPeople(), new Set([detail.id]))` (named people, excl. self)
  — mirrors the list toolbar control. On pick →
  `mergeDetailInto(targetId)` → `performMerge(targetId, [detail.id],
() => this.router.navigate(['/settings/people', targetId]))`.
- The name-click **rename** flow (`startEdit`/`commitEdit`) is unchanged.

## Shared / DRY helpers — `people.vm.ts`

- **`toggleKey(set: ReadonlySet<string>, key: string): Set<string>`** — the one
  immutable add/remove primitive. Refactor `toggleSelection(set, face)` to
  `toggleKey(set, faceKey(face))`. People selection calls `toggleKey(set, id)`.
- **`mergeTargets(named: ApiPerson[], excludeIds: ReadonlySet<string>): ApiPerson[]`**
  — named people minus excluded; feeds both pickers.
- **`mergePeopleConfirm(count: number, targetName: string): string`** and
  **`hidePeopleConfirm(count: number): string`** — singular/plural-aware copy,
  matching the existing `hidePersonConfirm` style.

### Component-level DRY

```ts
private async performMerge(
  targetId: string,
  sourceIds: string[],
  after: () => void,
): Promise<void>
```

Looks up the target name (`people().find`), confirms via `mergePeopleConfirm`,
increments `peopleBulkBusy`, `await store.mergePeople`, shows a success/error
toast (reusing `showToast` + `errorMessage`), runs `after()`, decrements busy.
Both the list and detail merge call sites share it; only `after` differs.

## Edge cases, a11y, performance

- **Empty target list** (no named people, or the only named person is selected):
  the "Merge into…" `<select>` renders a disabled placeholder; merge is
  unavailable. Hide still works.
- **Confirmations** before both bulk ops (reuse the `confirm()` pattern already
  used by `hidePerson`).
- **In-flight**: toolbar controls disabled while `peopleBulkBusy() > 0`.
- **Partial hide failure**: `allSettled` → toast reports ok/failed split (mirrors
  the face `bulkApply`); successful rows still leave the list (state refreshed).
- **a11y** (CLAUDE.md): the Select toggle, each selectable card
  (`role=button` + `aria-pressed`), and every toolbar control get explicit
  labels.
- **Performance**: settings-surface, not the render loop. Bulk merge is one
  round-trip; bulk hide is a small parallel fan-out. No render-loop allocation,
  no WASM-boundary cost.

## Testing

- **API** (`bun test`, real throwaway Mongo on :27077 per house practice —
  no in-mem dep; don't touch the dev DB on :27017):
  - `mergePeopleInto`: target survives (id/cover/`created_at` preserved), all
    source faces repointed to target, each source `merged_into = target`,
    `mergedCount`/`facesRepointed` correct.
  - Idempotent: re-merging an already-merged source is a no-op; merging a source
    into itself is skipped; missing source skipped; target-not-found and
    target-already-merged throw (→ 404 at the route).
  - Route `POST /api/people/merge`: happy path + invalid target (400) + unknown
    target (404).
- **Web** (`bun run test` / vitest): `toggleKey`, `mergeTargets` (exclusion),
  `mergePeopleConfirm`/`hidePeopleConfirm` copy. Pure `vm.ts` units — no DOM.
- **Format gate**: `bun run format` over the branch diff before pushing
  (Prettier is the only web style gate; check `main...HEAD` so new files are
  covered).

## Files touched

| File                                                                   | Change                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `src/api/src/people/people.repo.ts`                                    | `mergeInto` returns face count; new `mergePeopleInto`                 |
| `src/api/src/routes/people.ts`                                         | new `POST /api/people/merge`                                          |
| `src/api/src/people/*.test.ts`                                         | merge repo + route tests                                              |
| `src/web/projects/maple-common/src/lib/api/bun-api-backend.service.ts` | `mergePeople` + `ApiMergeResult`                                      |
| `src/web/projects/maple-common/src/lib/api/people.store.ts`            | `mergePeople`, `hidePeople`, shared invalidate tail                   |
| `src/web/projects/maple/src/app/settings/people/people.component.ts`   | select mode, bulk merge/hide, detail merge picker, `performMerge`     |
| `src/web/projects/maple/src/app/settings/people/people.component.html` | Select toggle, select-mode cards, list bulk toolbar, detail picker    |
| `src/web/projects/maple/src/app/settings/people/people.component.scss` | minor (selected-card affordance; reuse `.bulk-toolbar`)               |
| `src/web/projects/maple/src/app/settings/people/people.vm.ts`          | `toggleKey`, `mergeTargets`, confirm copy; refactor `toggleSelection` |
| `src/web/projects/maple/src/app/settings/people/*.spec.ts`             | vm unit tests                                                         |

## Ticket

Open a GitHub issue (Files board) before implementation; the PR closes it with a
`Closes #N` line.
