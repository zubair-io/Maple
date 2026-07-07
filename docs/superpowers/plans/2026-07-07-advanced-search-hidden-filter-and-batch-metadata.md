# Advanced Search: hidden filter + batch metadata editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hidden-image tri-state filter and a selection-driven Batch Metadata editor to the Advanced Search page (`/search/advanced`).

**Architecture:** The `hidden` filter is pure plumbing through the existing URL-param → `SearchParams` pipeline (`search.vm.ts` / `search.component.ts`), since `/api/search` already implements the `hidden` query param. The batch metadata editor requires one small backend addition first: `/api/search` results currently carry only a legacy `fs:<absPath>` id that the metadata-snapshot/apply endpoints cannot resolve (they require `slug:relPath` addresses) — so `projectAsset()` gains a proper `address: string | null` field, computed the same way `people.repo.ts` already computes cover-asset addresses (`loadLibraryIdToSlug()` + `fileinfo`). The frontend then reuses `BatchMetadataService` + `<app-batch-metadata-panel>` exactly as `browse-shell.component.ts` does, keyed on `address` instead of legacy `id`.

**Tech Stack:** Bun + Elysia + MongoDB (`src/api`), Angular 21 standalone components + signals (`src/web/projects/maple`), Vitest (web) / `bun:test` (api).

## Global Constraints

- Non-destructive only — this feature only reads/writes existing XMP-backed metadata via already-existing endpoints; no new mutation path.
- No new environment variables or ad-hoc settings — this is UI + a projection field, not a runtime knob.
- Prefer functional/immutable style: `const` bindings, ternaries, early returns — no reassigned `let` across branching logic.
- Angular: standalone components, signals, `input()`/`output()`, existing `*.vm.ts` co-location pattern for pure logic.
- Every PR closes a ticket — a GitHub issue must exist and be referenced (`Closes #N`) before opening the PR (final task).

---

## File Structure

**Backend (`src/api/src/routes/search/`):**
- Modify `project.ts` — add `address: string | null` to `SearchResult`, extend `projectAsset()` to accept an `idToSlug` map and compute the address.
- Modify `list.ts` — load `loadLibraryIdToSlug()` at both `projectAsset()` call sites and pass it through.
- Create `project.test.ts` — pure unit tests for the new address computation (no Mongo).

**Frontend (`src/web/projects/maple-common/src/lib/api/`):**
- Modify `search.service.ts` — add `address: string | null` to the `SearchResult` interface.

**Frontend (`src/web/projects/maple/src/app/search/`):**
- Modify `search.vm.ts` — add `HiddenValue` type, `parseHidden()`, `HIDDEN_OPTIONS`, extend `SearchFormState`/`buildSearchParams()`.
- Modify `search.vm.spec.ts` — cover the new pure functions.
- Modify `search.component.ts` — add the `hidden` computed signal + `setHidden()`; add selection state (`selectedIds`, `toggleSelect`, `selectAllLoaded`, `clearSelection`), batch-metadata dialog state (`batchMetaDialogVisible`, `batchMetaAssetSnapshots`), `onEditMetadata()`, `onBatchMetaDismiss()`.
- Modify `search.component.html` — add the hidden filter control, per-result checkbox, selection toolbar, and `<app-batch-metadata-panel>`.

---

### Task 1: Backend — `address` field on `SearchResult`

**Files:**
- Modify: `src/api/src/routes/search/project.ts`
- Test: `src/api/src/routes/search/project.test.ts` (new)

**Interfaces:**
- Consumes: `loadLibraryIdToSlug(): Promise<ReadonlyMap<string, string>>` (already exists, `src/api/src/indexer/libraries.cache.ts:82`); `assetPrimaryFileInfo(asset): FileInfo | null` (already imported in `project.ts`).
- Produces: `projectAsset(d, libs, idToSlug): SearchResult` — new third parameter `idToSlug: ReadonlyMap<string, string>`; `SearchResult.address: string | null`. Task 2 and Task 4 depend on this exact signature and field name.

- [ ] **Step 1: Write the failing test**

Create `src/api/src/routes/search/project.test.ts`:

```typescript
/**
 * Pure unit tests for `projectAsset`'s address computation. No Mongo — all
 * inputs are plain fixtures, mirroring the pattern in `nl-date.test.ts`.
 */

import { describe, it, expect } from 'bun:test';
import { ObjectId } from 'mongodb';
import type { AssetDoc } from '../../db/schema.ts';
import { projectAsset } from './project.ts';

function fixtureDoc(overrides: Partial<AssetDoc> = {}): AssetDoc & { _id: ObjectId } {
  return {
    _id: new ObjectId(),
    size: 1024,
    mtime: 1700000000000,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: '2026-01-01T00:00:00.000Z',
    fileinfo: [
      {
        path: 'vacation/2024',
        filename: 'IMG_0001.dng',
        library_id: new ObjectId('507f1f77bcf86cd799439011'),
      },
    ],
    ...overrides,
  } as AssetDoc & { _id: ObjectId };
}

describe('projectAsset — address field', () => {
  it('computes slug:relPath when the primary library has a registered slug', () => {
    const doc = fixtureDoc();
    const libs = new Map<string, string>();
    const idToSlug = new Map<string, string>([['507f1f77bcf86cd799439011', 'my-library']]);
    const result = projectAsset(doc, libs, idToSlug);
    expect(result.address).toBe('my-library:vacation/2024/IMG_0001.dng');
  });

  it('handles a library-root file (empty relPath directory)', () => {
    const doc = fixtureDoc({
      fileinfo: [
        { path: '', filename: 'IMG_0002.dng', library_id: new ObjectId('507f1f77bcf86cd799439011') },
      ],
    });
    const libs = new Map<string, string>();
    const idToSlug = new Map<string, string>([['507f1f77bcf86cd799439011', 'my-library']]);
    const result = projectAsset(doc, libs, idToSlug);
    expect(result.address).toBe('my-library:IMG_0002.dng');
  });

  it('returns null when the primary library has no registered slug', () => {
    const doc = fixtureDoc();
    const libs = new Map<string, string>();
    const idToSlug = new Map<string, string>(); // no slug registered
    const result = projectAsset(doc, libs, idToSlug);
    expect(result.address).toBeNull();
  });

  it('returns null when the doc has no fileinfo', () => {
    const doc = fixtureDoc({ fileinfo: undefined });
    const libs = new Map<string, string>();
    const idToSlug = new Map<string, string>([['507f1f77bcf86cd799439011', 'my-library']]);
    const result = projectAsset(doc, libs, idToSlug);
    expect(result.address).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/api && bun test src/routes/search/project.test.ts`
Expected: FAIL — `projectAsset` currently takes only 2 arguments and `SearchResult` has no `address` field (TypeScript/runtime error, or `result.address` is `undefined` not matching `'my-library:...'`/`null`).

- [ ] **Step 3: Write minimal implementation**

In `src/api/src/routes/search/project.ts`, add `address: string | null;` to the `SearchResult` interface right after `id: string;` (line 20):

```typescript
export interface SearchResult {
  id: string;
  /** `slug:relPath` address for the metadata-snapshot/batch-apply endpoints
   * (`/api/metadata/snapshots`, `/api/xmp/batch`), which only understand the
   * unified addressing scheme — the legacy `id` field above predates that
   * migration and is not a valid input to those endpoints. `null` when the
   * asset's primary library has no registered slug. */
  address: string | null;
  _id: string;
  ...
```

Change the `projectAsset` signature and body to accept and use `idToSlug`:

```typescript
export function projectAsset(
  d: AssetDoc & { _id: ObjectId },
  libraries: ReadonlyMap<string, string>,
  idToSlug: ReadonlyMap<string, string>,
): SearchResult {
  const exif = d.exif ?? null;
  const camera =
    exif && (exif.camera_make !== null || exif.camera_model !== null)
      ? { make: exif.camera_make, model: exif.camera_model }
      : null;
  const primary = assetPrimaryFileInfo(d);
  const absPath = assetAbsPath(d, libraries) ?? '';
  const folderId = primary?.library_id.toHexString() ?? '';
  const filename = primary?.filename ?? '';
  const slug = primary ? (idToSlug.get(primary.library_id.toHexString()) ?? null) : null;
  const address =
    slug && primary
      ? `${slug}:${primary.path ? `${primary.path}/${primary.filename}` : primary.filename}`
      : null;
  const result: SearchResult = {
    // The editor's id format is `fs:<absPath>` (matches Hosted's
    // browser-FS-Access keys); keeping the same shape here lets the FE
    // route a search hit straight into the editor.
    id: `fs:${absPath}`,
    address,
    _id: d._id.toHexString(),
    folder_id: folderId,
    abs_path: absPath,
    filename,
    ...
```

(Leave every field below `filename` in the existing `result` object literal unchanged — only the two lines above are new.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/api && bun test src/routes/search/project.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/src/routes/search/project.ts src/api/src/routes/search/project.test.ts
git commit -m "feat(api): add slug:relPath address field to search results"
```

---

### Task 2: Backend — thread `idToSlug` through the search route

**Files:**
- Modify: `src/api/src/routes/search/list.ts:150-151` and `:187-188`
- Test: reuses Task 1's tests plus the existing search integration tests (run as verification, not new tests — this task has no new pure logic, only wiring two existing call sites to Task 1's new parameter).

**Interfaces:**
- Consumes: `loadLibraryIdToSlug()` (`src/api/src/indexer/libraries.cache.ts:82`), `projectAsset(d, libs, idToSlug)` from Task 1.
- Produces: both `/api/search` response code paths (Meilisearch hit path and the Mongo `$text`/filter path) now populate `address` on every result.

- [ ] **Step 1: Update the Meilisearch-hit path**

In `src/api/src/routes/search/list.ts`, add the import:

```typescript
import { loadLibraryRoots, loadLibraryIdToSlug } from '../../indexer/libraries.cache.ts';
```

Change line 150-151:

```typescript
        const libs = await loadLibraryRoots().catch(() => new Map<string, string>());
        const idToSlug = await loadLibraryIdToSlug().catch(() => new Map<string, string>());
        const results = ordered.map((d) => projectAsset(d, libs, idToSlug));
```

- [ ] **Step 2: Update the Mongo filter path**

Change line 187-188:

```typescript
    const libs = await loadLibraryRoots().catch(() => new Map<string, string>());
    const idToSlug = await loadLibraryIdToSlug().catch(() => new Map<string, string>());
    const results = docs.map((d) => projectAsset(d as AssetDoc & { _id: ObjectId }, libs, idToSlug));
```

- [ ] **Step 3: Typecheck and run the existing search test suite**

Run: `cd src/api && bun run tsc --noEmit` (or the project's existing typecheck command if different — check `package.json` `scripts.typecheck`)
Expected: no new type errors (the two call sites are the only callers of `projectAsset` outside `project.ts` itself — confirmed by `grep -rln projectAsset src/api/src/routes/search/` in Task 1's investigation).

Run: `cd src/api && bun test src/routes/search/`
Expected: PASS — existing search route tests don't assert on `SearchResult.address` today, so they should be unaffected; this run just confirms nothing else broke.

- [ ] **Step 4: Commit**

```bash
git add src/api/src/routes/search/list.ts
git commit -m "feat(api): populate search result address at both query paths"
```

---

### Task 3: Frontend — expose `address` on the client `SearchResult`

**Files:**
- Modify: `src/web/projects/maple-common/src/lib/api/search.service.ts`

**Interfaces:**
- Consumes: Task 2's API response shape (already includes `address` once Tasks 1-2 land; this task just types it).
- Produces: `SearchResult.address: string | null`, consumed by Task 6 (`onEditMetadata()`).

- [ ] **Step 1: Add the field**

In `src/web/projects/maple-common/src/lib/api/search.service.ts`, in the `SearchResult` interface (around line 80-104), add directly after the `id: string;` line:

```typescript
  id: string;
  /** `slug:relPath` address — the only address form the batch-metadata
   * endpoints (`fetchSnapshots`, `batchApply`) accept. `null` when the
   * asset's primary library has no registered slug. */
  address: string | null;
```

- [ ] **Step 2: Typecheck**

Run: `cd src/web && bun x ng build maple-common 2>&1 | tail -30` (or the project's existing `tsc`/build check — confirm via `package.json`)
Expected: no new type errors. This is a pure additive interface field; no existing consumer destructures `SearchResult` exhaustively, so nothing breaks.

- [ ] **Step 3: Commit**

```bash
git add src/web/projects/maple-common/src/lib/api/search.service.ts
git commit -m "feat(web): type the search result address field"
```

---

### Task 4: Frontend — hidden filter pure logic (`search.vm.ts`)

**Files:**
- Modify: `src/web/projects/maple/src/app/search/search.vm.ts`
- Modify: `src/web/projects/maple/src/app/search/search.vm.spec.ts`

**Interfaces:**
- Consumes: nothing new — pure TypeScript, same shape as the existing `parseScreenshot`/`ScreenshotValue` pattern already in this file.
- Produces: `HiddenValue` type, `parseHidden()`, `HIDDEN_OPTIONS`, `SearchFormState.hidden`, `buildSearchParams().hidden`. Task 5 consumes all four by name.

- [ ] **Step 1: Write the failing tests**

In `search.vm.spec.ts`, add after the `describe('parseScreenshot', ...)` block (after line 160):

```typescript
describe('parseHidden', () => {
  it('accepts the two non-default literals', () => {
    expect(parseHidden('all')).toBe('all');
    expect(parseHidden('only')).toBe('only');
  });

  it('falls back to "" (hide hidden, the default) for anything else', () => {
    expect(parseHidden(null)).toBe('');
    expect(parseHidden(undefined)).toBe('');
    expect(parseHidden('')).toBe('');
    expect(parseHidden('ALL')).toBe('');
    expect(parseHidden('garbage')).toBe('');
  });
});
```

Add `HIDDEN_OPTIONS` import to the top `import { ... } from './search.vm';` block and a constants test in the `describe('constants', ...)` block (after the `COLOR_LABELS` test, around line 73):

```typescript
  it('HIDDEN_OPTIONS leads with the default "hide hidden" option', () => {
    expect(HIDDEN_OPTIONS[0]).toEqual({ value: '', label: 'Hide hidden' });
    expect(HIDDEN_OPTIONS.map((o) => o.value)).toEqual(['', 'all', 'only']);
  });
```

Add `hidden` to `emptyState()` in the `describe('buildSearchParams', ...)` block (line 286-310) and a new test after the existing `isScreenshot` mapping test (after line 365):

```typescript
  it('maps the tri-state hidden filter to the backend param / undefined', () => {
    expect(buildSearchParams({ ...emptyState(), hidden: 'all' }).hidden).toBe('all');
    expect(buildSearchParams({ ...emptyState(), hidden: 'only' }).hidden).toBe('only');
    expect(buildSearchParams({ ...emptyState(), hidden: '' }).hidden).toBeUndefined();
  });
```

(`emptyState()` needs `hidden: '' as const,` added alongside the existing `isScreenshot: '' as const,` line so every other `buildSearchParams` test in the file keeps compiling.)

Update the spec's import list at the top to include `parseHidden` and `HIDDEN_OPTIONS`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src/web && bunx vitest run projects/maple/src/app/search/search.vm.spec.ts`
Expected: FAIL — `parseHidden` and `HIDDEN_OPTIONS` are not exported yet; `emptyState()` / `buildSearchParams` don't have a `hidden` field.

- [ ] **Step 3: Write minimal implementation**

In `search.vm.ts`, add the type next to `ScreenshotValue` (line 48):

```typescript
export type HiddenValue = '' | 'all' | 'only';
```

Add the parser next to `parseScreenshot` (after line 124):

```typescript
export function parseHidden(v: string | null | undefined): HiddenValue {
  return v === 'all' || v === 'only' ? v : '';
}
```

Add the options table next to `COLOR_LABELS` (after line 61):

```typescript
/** Tri-state hidden-image filter. The backend only has two explicit modes
 * (`all`, `only`) — `''` sends no param, which is today's implicit
 * exclude-hidden default, spelled out here so the control isn't ambiguous
 * about what it's filtering. */
export const HIDDEN_OPTIONS: ReadonlyArray<{ value: HiddenValue; label: string }> = [
  { value: '', label: 'Hide hidden' },
  { value: 'all', label: 'Show all' },
  { value: 'only', label: 'Hidden only' },
];
```

Add `hidden: HiddenValue;` to `SearchFormState` (after `isScreenshot: ScreenshotValue;`, line 231):

```typescript
  isScreenshot: ScreenshotValue;
  hidden: HiddenValue;
  sort: SearchSort;
```

Add the mapping in `buildSearchParams()` (after the `isScreenshot` line, 263):

```typescript
    isScreenshot: s.isScreenshot === 'true' ? true : s.isScreenshot === 'false' ? false : undefined,
    hidden: s.hidden === 'all' || s.hidden === 'only' ? s.hidden : undefined,
    sort: s.sort,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src/web && bunx vitest run projects/maple/src/app/search/search.vm.spec.ts`
Expected: PASS (all tests, including the 2 new `describe` blocks and the updated `emptyState`).

- [ ] **Step 5: Commit**

```bash
git add src/web/projects/maple/src/app/search/search.vm.ts src/web/projects/maple/src/app/search/search.vm.spec.ts
git commit -m "feat(web): add hidden-filter pure logic to search view model"
```

---

### Task 5: Frontend — wire the hidden filter into the component + template

**Files:**
- Modify: `src/web/projects/maple/src/app/search/search.component.ts`
- Modify: `src/web/projects/maple/src/app/search/search.component.html`

**Interfaces:**
- Consumes: `HiddenValue`, `parseHidden`, `HIDDEN_OPTIONS` from Task 4.
- Produces: `hidden` computed signal, `setHidden()` method — no other task depends on these by name (leaf of the hidden-filter slice).

- [ ] **Step 1: Import and wire the signal**

In `search.component.ts`, add `HiddenValue`, `HIDDEN_OPTIONS`, `parseHidden` to the `./search.vm` import list (alongside the existing `ScreenshotValue`/`parseScreenshot`/etc., lines 50-77).

Add the computed signal next to `isScreenshot` (after line 128):

```typescript
  readonly hidden = computed<HiddenValue>(() => parseHidden(this.query()?.get('hidden')));
```

Add `hiddenOptions` next to `colorOptions`/`sceneTypeOptions` (line 152-154):

```typescript
  readonly hiddenOptions = HIDDEN_OPTIONS;
```

Add `hidden: this.hidden(),` to `currentParams()` (after `isScreenshot: this.isScreenshot(),`, line 251):

```typescript
      isScreenshot: this.isScreenshot(),
      hidden: this.hidden(),
      sort: this.sort(),
```

Add the setter next to `setIsScreenshot` (after line 363):

```typescript
  setHidden(value: HiddenValue): void {
    this.patchQueryParams({ hidden: value || null, page: null });
  }
```

- [ ] **Step 2: Add the template control**

In `search.component.html`, add a new section directly after the "Screenshot tri-state" section (after line 254, before the "ISO" section):

```html
      <!-- Hidden tri-state -->
      <section class="mb-[18px]">
        <h3 class="mb-2 mt-0 text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          Hidden
        </h3>
        <select
          class="h-8 w-full rounded border border-border bg-surface-alt px-2 text-[12px] text-text-main"
          [value]="hidden()"
          (change)="setHidden($any($event.target).value)"
          aria-label="Hidden images"
        >
          @for (o of hiddenOptions; track o.value) {
            <option [value]="o.value">{{ o.label }}</option>
          }
        </select>
      </section>
```

- [ ] **Step 3: Manual verification in the dev server**

Run: `cd src/web && bun x ng serve maple` (skip if already running)
Navigate to `/search/advanced`. Confirm:
- The "Hidden" dropdown appears with "Hide hidden" / "Show all" / "Hidden only" options.
- Selecting "Hidden only" adds `?hidden=only` to the URL and the request re-fires (network tab shows `/api/search?...&hidden=only`).
- Selecting "Hide hidden" removes the `hidden` param from the URL entirely.

- [ ] **Step 4: Commit**

```bash
git add src/web/projects/maple/src/app/search/search.component.ts src/web/projects/maple/src/app/search/search.component.html
git commit -m "feat(web): add hidden-image filter to advanced search"
```

---

### Task 6: Frontend — selection state + Batch Metadata editor wiring

**Files:**
- Modify: `src/web/projects/maple/src/app/search/search.component.ts`
- Modify: `src/web/projects/maple/src/app/search/search.component.html`

**Interfaces:**
- Consumes: `BatchMetadataService`, `BatchMetadataPanelComponent`, `AssetMetadataSnapshot` (all barrel-exported from `@maple-common`); `SearchResult.address` from Task 3.
- Produces: `selectedIds`, `toggleSelect()`, `selectAllLoaded()`, `clearSelection()`, `batchMetaDialogVisible`, `batchMetaAssetSnapshots`, `onEditMetadata()`, `onBatchMetaDismiss()` — leaf of the batch-editor slice, nothing downstream depends on these.

- [ ] **Step 1: Add selection + dialog state to the component**

In `search.component.ts`, add to the `@maple-common` import list (alongside `SearchService`, etc.):

```typescript
import {
  AssetMetadataSnapshot,
  BatchMetadataPanelComponent,
  BatchMetadataService,
  ...
} from '@maple-common';
```

Add `BatchMetadataPanelComponent` to the `@Component({ imports: [...] })` array.

Add the service injection next to `private readonly search = inject(SearchService);` (line 92):

```typescript
  private readonly batchMetadataService = inject(BatchMetadataService);
```

Add selection + dialog signals next to `readonly error = signal<string | null>(null);` (line 149):

```typescript
  readonly selectedIds = signal<ReadonlySet<string>>(new Set());
  readonly batchMetaDialogVisible = signal(false);
  readonly batchMetaAssetSnapshots = signal<AssetMetadataSnapshot[]>([]);

  readonly selectedCount = computed(() => this.selectedIds().size);
```

- [ ] **Step 2: Add selection methods**

Add after `openResult()` (after line 469):

```typescript
  // ── Selection ─────────────────────────────────────────────────────────────
  toggleSelect(id: string): void {
    this.selectedIds.update((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  selectAllLoaded(): void {
    this.selectedIds.set(new Set(this.results().map((r) => r.id)));
  }

  clearSelection(): void {
    this.selectedIds.set(new Set());
  }
```

- [ ] **Step 3: Clear selection on filter/query change**

In the constructor's `effect()` (lines 197-209), add `this.clearSelection();` after the existing `untracked(...)` block, before `this.scheduleSearch();`:

```typescript
    effect(() => {
      const m = this.query();
      if (!m) return;
      const urlQ = m.get('q') ?? '';
      untracked(() => {
        if (urlQ !== this.qInput()) this.qInput.set(urlQ);
      });
      this.clearSelection();
      this.scheduleSearch();
      this.scheduleFacets();
    });
```

- [ ] **Step 4: Add the batch metadata dialog handlers**

Add after `clearSelection()`:

```typescript
  // ── Batch metadata dialog ────────────────────────────────────────────────
  onEditMetadata(): void {
    const ids = this.selectedIds();
    const addresses = this.results()
      .filter((r) => ids.has(r.id))
      .map((r) => r.address)
      .filter((a): a is string => a !== null);
    if (addresses.length === 0) return;

    this.batchMetadataService.fetchSnapshots(addresses).subscribe({
      next: (snapshots) => {
        this.batchMetaAssetSnapshots.set(snapshots);
        this.batchMetaDialogVisible.set(true);
      },
      error: () => {
        this.error.set('Could not load metadata for the selected results.');
      },
    });
  }

  onBatchMetaDismiss(): void {
    this.batchMetaDialogVisible.set(false);
    this.batchMetaAssetSnapshots.set([]);
    this.clearSelection();
    void this.runSearch(/*append*/ false);
  }
```

- [ ] **Step 5: Add the selection toolbar + checkboxes to the template**

In `search.component.html`, add a selection toolbar right after the closing `</header>` (after line 58), before the `<div class="flex min-h-0 flex-1">` results/sidebar row:

```html
  @if (selectedCount() > 0) {
    <div
      class="flex h-9 flex-shrink-0 items-center gap-3 border-b-[0.5px] border-border bg-surface-alt px-4 text-[12px] text-text-main"
    >
      <span>{{ selectedCount() }} selected</span>
      <button
        type="button"
        class="cursor-pointer rounded border-[0.5px] border-border bg-input-bg px-2.5 py-1 text-[11px] hover:bg-surface-hover"
        (click)="selectAllLoaded()"
      >
        Select all (loaded)
      </button>
      <button
        type="button"
        class="cursor-pointer rounded border-[0.5px] border-border bg-input-bg px-2.5 py-1 text-[11px] hover:bg-surface-hover"
        (click)="onEditMetadata()"
      >
        Edit metadata…
      </button>
      <button
        type="button"
        class="ml-auto cursor-pointer rounded border-[0.5px] border-border bg-input-bg px-2.5 py-1 text-[11px] hover:bg-surface-hover"
        (click)="clearSelection()"
      >
        Clear
      </button>
    </div>
  }
```

Add a checkbox to each result card. The card is currently a `<button>` (lines 510-550) — nesting an `<input type="checkbox">` inside a native `<button>` is invalid HTML (browsers hoist it out and behavior becomes inconsistent), so change the card element from `<button>` to a `<div>` with a click handler and keyboard support:

```html
      <div class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
        @for (r of results(); track trackResult($index, r)) {
          <div
            class="group relative flex cursor-pointer flex-col gap-1.5 rounded-md border-[0.5px] border-border bg-surface p-1.5 text-left text-text-main transition-[background,border-color] duration-[120ms] hover:border-text-muted hover:bg-surface-alt"
            role="button"
            tabindex="0"
            (click)="openResult(r)"
            (keydown.enter)="openResult(r)"
            [attr.aria-label]="'Open ' + r.filename"
          >
            <input
              type="checkbox"
              class="absolute left-2 top-2 z-10 h-4 w-4 cursor-pointer"
              [checked]="selectedIds().has(r.id)"
              [attr.aria-label]="'Select ' + r.filename"
              (click)="$event.stopPropagation()"
              (change)="toggleSelect(r.id)"
            />
            <div class="relative aspect-[3/2] overflow-hidden rounded bg-image-canvas">
              @if (r.thumbUrl) {
                <img
                  class="block h-full w-full object-cover"
                  [src]="r.thumbUrl"
                  [alt]="r.filename"
                  loading="lazy"
                  decoding="async"
                />
              } @else if (r.thumbLoading) {
                <div class="skeleton h-full w-full"></div>
              }
              @if (r.rating > 0) {
                <div
                  class="absolute bottom-1 right-1 flex gap-px rounded-[3px] bg-black/55 px-1 py-0.5"
                >
                  @for (s of stars; track s) {
                    <maple-icon
                      [name]="s <= r.rating ? 'star-filled' : 'star'"
                      [size]="9"
                      [color]="s <= r.rating ? 'var(--color-star)' : 'rgba(255,255,255,0.35)'"
                    />
                  }
                </div>
              }
            </div>
            <div class="flex flex-col gap-0.5 px-1 pb-0.5">
              <span class="overflow-hidden text-ellipsis whitespace-nowrap text-[12px]">{{
                r.filename
              }}</span>
              @if (r.captured_at) {
                <span class="text-[11px] text-text-muted">{{ r.captured_at | slice: 0 : 10 }}</span>
              }
            </div>
          </div>
        }
      </div>
```

Add the panel at the very end of the template, right before the closing `</div>` of the root element (after line 571, before line 572):

```html
  <app-batch-metadata-panel
    [visible]="batchMetaDialogVisible()"
    [assetSnapshots]="batchMetaAssetSnapshots()"
    (dismiss)="onBatchMetaDismiss()"
  />
```

- [ ] **Step 6: Manual verification in the dev server**

With the dev server running (`bun x ng serve maple`) and a self-hosted API + at least one indexed asset with a registered library slug:
1. Navigate to `/search/advanced`, run a query that returns results.
2. Click a result's checkbox — confirm the toolbar appears with "1 selected" and clicking the checkbox did NOT navigate to Preview.
3. Click "Select all (loaded)" — confirm the count matches the currently-rendered result count, not the total server-side match count.
4. Click "Edit metadata…" — confirm the batch metadata panel opens with the selected assets' snapshots (not empty "(mixed)" placeholders — this is the regression Task 1-3 exist to prevent).
5. Toggle the "Hidden" field to hidden in the panel, apply, dismiss — confirm the search results refresh and (if the current `hidden` filter excludes hidden) the just-hidden asset drops out of the visible list.

- [ ] **Step 7: Commit**

```bash
git add src/web/projects/maple/src/app/search/search.component.ts src/web/projects/maple/src/app/search/search.component.html
git commit -m "feat(web): add selection + batch metadata editor to advanced search results"
```

---

### Task 7: Open the ticket and PR

**Files:** none (process step)

- [ ] **Step 1: Create the GitHub issue**

Run: `gh issue create --title "Advanced Search: hidden-image filter + batch metadata editor" --body "Advanced Search has no way to filter for hidden images even though /api/search already supports it, and no way to bulk-edit metadata on search results the way Browse can. Adds a hidden tri-state filter and wires the existing Batch Metadata editor into the search results page. Spec: docs/superpowers/specs/2026-07-07-advanced-search-hidden-filter-and-batch-metadata-design.md"`

Note the returned issue number `#N`.

- [ ] **Step 2: Tag the issue to the Files board**

Run: `gh issue edit <N> --add-project Files`

- [ ] **Step 3: Push the branch and open the PR**

```bash
git push -u origin HEAD
gh pr create --title "Advanced Search: hidden-image filter + batch metadata editor" --body "$(cat <<'EOF'
## Summary
- Adds a tri-state hidden-image filter (Hide hidden / Show all / Hidden only) to Advanced Search, mirroring the existing Screenshot filter.
- Adds selection + the existing Batch Metadata editor to Advanced Search results, matching the Browse grid's flow.
- Backend: adds a proper `slug:relPath` `address` field to `/api/search` results — the editor's existing `fs:<absPath>` id predates the unified-addressing migration and can't be resolved by the metadata-snapshot/batch-apply endpoints.

Closes #<N>

## Test plan
- [ ] `cd src/api && bun test src/routes/search/`
- [ ] `cd src/web && bunx vitest run projects/maple/src/app/search/search.vm.spec.ts`
- [ ] Manual: hidden filter round-trips through the URL for all three states
- [ ] Manual: select results, batch-edit metadata (including toggling Hidden), confirm results refresh on dismiss
EOF
)"
```

Open as ready for review (not draft).

---

## Self-Review Notes

- **Spec coverage:** Hidden filter (Task 4-5) ✓. Selection + batch editor (Task 6) ✓. Address-field backend gap discovered during investigation (not in the original spec's "no backend changes" assumption) — covered by Tasks 1-3, and the design doc's "no backend changes" claim should be corrected to reference this plan when read together.
- **Placeholder scan:** no TBD/TODO; every step has literal code.
- **Type consistency:** `HiddenValue`/`parseHidden`/`HIDDEN_OPTIONS` names consistent across Tasks 4-5; `SearchResult.address` name consistent across Tasks 1-3 and consumed as `r.address` in Task 6.
