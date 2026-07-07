# Advanced Search: hidden-image filter + batch metadata editor — design

- **Date:** 2026-07-07
- **Status:** Draft (awaiting review)
- **Area:** `src/web` (Angular, `maple` project's `/search/advanced` page)
- **Builds on:** the existing `/api/search` `hidden` filter param (already implemented server-side), and the Batch Metadata editor (`docs/superpowers/specs/2026-06-26-batch-metadata-editor-design.md`), already wired into the Browse grid via `browse-shell.component.ts`.

## Problem

The Advanced Search page (`/search/advanced`, `src/web/projects/maple/src/app/search/search.component.ts`) supports rich filtering (camera, lens, EXIF ranges, rating, color, scene type, subjects, etc.) but has no way to filter by hidden status, even though the backend (`/api/search`, `search.service.ts`'s `SearchParams.hidden`) already supports `hidden=all` / `hidden=only`. A user cannot search specifically for hidden images.

Separately, once a user finds assets via Advanced Search, there is no way to bulk-edit their metadata — the Batch Metadata editor only exists on the Browse grid (`browse-shell.component.ts`). Advanced Search results have no selection state at all: each row is a click-to-view link.

A related, previously-unclear point: Browse and Advanced Search return different results for hidden images because they hit two different backend routes with different default filtering — Browse's `/api/folder/:slug/*` (`src/api/src/routes/library/folder.ts`) applies no `hidden` filter at all, while `/api/search` (`src/api/src/routes/search/query.ts:436-444`) defaults to excluding hidden assets (`hidden: { $ne: true }`) unless overridden. This is a documentation/UX gap, not a bug to fix — no backend change is proposed here.

## Goals

1. Add a **hidden-image filter** to Advanced Search: a tri-state control mirroring the existing Screenshot filter, with states:
   - **Hide hidden (default)** — today's implicit behavior; no `hidden` param sent.
   - **Show all** — sends `hidden=all`.
   - **Hidden only** — sends `hidden=only`.
2. Add **selection + the Batch Metadata editor** to Advanced Search results:
   - A checkbox on each result card toggles selection, without navigating to Preview.
   - A selection toolbar appears once ≥1 result is selected: shows count, "Select all (loaded)" (scoped to the currently-fetched page(s) via infinite scroll, not the full server-side result set), "Edit metadata…", "Clear".
   - "Edit metadata…" opens the existing `<app-batch-metadata-panel>` (from `@maple-common`), fed via `BatchMetadataService.fetchSnapshots(addresses)`, exactly as `browse-shell.component.ts` does today.
   - On panel dismiss: clear selection and re-run the current search so any changed fields (including a newly set/cleared `hidden` flag) are reflected immediately.

## Non-goals

- No backend/API changes — `hidden` filter param and `/api/metadata/snapshots` + `/api/xmp/batch` already support everything needed.
- No change to Browse's folder route or its hidden-image behavior.
- No cross-page (server-side) "select all matching results" — selection is explicitly scoped to what's already loaded in the browser, to avoid an accidental bulk edit across an unseen result set.
- No single-asset context-menu metadata edit for search results — only the existing multi-select batch flow.

## Design

### Hidden filter

- `search.vm.ts`:
  - `export type HiddenValue = '' | 'all' | 'only';`
  - `parseHidden(v: string | null | undefined): HiddenValue` — same shape as `parseScreenshot`.
  - Add `hidden: HiddenValue` to `SearchFormState`.
  - In `buildSearchParams()`: `hidden: s.hidden === 'all' || s.hidden === 'only' ? s.hidden : undefined`.
  - `HIDDEN_OPTIONS: ReadonlyArray<{ value: HiddenValue; label: string }>` = `[{ '', 'Hide hidden' }, { 'all', 'Show all' }, { 'only', 'Hidden only' }]`.
- `search.component.ts`:
  - `readonly hidden = computed<HiddenValue>(() => parseHidden(this.query()?.get('hidden')));`
  - Include `hidden: this.hidden()` in `currentParams()`.
  - `setHidden(value: HiddenValue): void { this.patchQueryParams({ hidden: value || null, page: null }); }`
- `search.component.html`: add a segmented control next to the existing Screenshot filter, same markup/style pattern, driven by `hiddenOptions` and `setHidden()`.
- Spec coverage: extend `search.vm.spec.ts` with `parseHidden` and `buildSearchParams` cases for the new field, following the existing `isScreenshot` test shape.

### Selection + batch metadata editor

- `search.component.ts`:
  - `readonly selectedIds = signal<ReadonlySet<string>>(new Set());`
  - `toggleSelect(id: string): void` — flips membership.
  - `selectAllLoaded(): void` — sets `selectedIds` to all `results().map(r => r.id)`.
  - `clearSelection(): void`.
  - Clear selection whenever `currentParams()` changes (new filter/query = stale selection) — do this inside the existing URL-driven `effect()` in the constructor, alongside the existing `scheduleSearch()`/`scheduleFacets()` calls.
  - `readonly batchMetaDialogVisible = signal(false);`
  - `readonly batchMetaAssetSnapshots = signal<AssetMetadataSnapshot[]>([]);`
  - `onEditMetadata(): void` — mirrors `browse-shell.component.ts:150-182`: resolve `addresses = results().filter(r => selectedIds().has(r.id)).map(r => r.id)` (already `"fs:" + abs_path`, the same address scheme Browse and the batch-metadata API already use), call `this.batchMetadataService.fetchSnapshots(addresses)`, then set `batchMetaAssetSnapshots` and `batchMetaDialogVisible`.
  - `onBatchMetaDismiss(): void` — hide the panel, clear snapshots and selection, and call `this.runSearch(false)` to refresh the current page.
  - Inject `BatchMetadataService` (barrel-exported from `@maple-common`, no export changes needed).
- `search.component.html`:
  - Add a checkbox to each result card's markup (visible on hover or always — match the existing Browse grid checkbox affordance for consistency), wired to `toggleSelect(r.id)`, with a `(click)="$event.stopPropagation()"` guard so it doesn't also fire `openResult()`.
  - Add a selection toolbar (shown when `selectedIds().size > 0`) with the count, "Select all (loaded)", "Edit metadata…", "Clear" actions.
  - Add `<app-batch-metadata-panel [visible]="batchMetaDialogVisible()" [assetSnapshots]="batchMetaAssetSnapshots()" (dismiss)="onBatchMetaDismiss()" />`, imported into the component's standalone `imports` array from `@maple-common`.
- No new spec file needed for the panel itself (already tested where it's defined); add a couple of `search.vm.spec.ts`-style unit tests only if any new pure logic is extracted (e.g. an address-resolution helper) — selection/dialog wiring itself is component glue, consistent with how `browse-shell.component.ts` is untested at that level today.

## Testing

- `bun x vitest run` (or the project's existing `search.vm.spec.ts` runner) for the new `parseHidden`/`buildSearchParams` cases.
- Manual verification in the dev server: confirm the hidden filter round-trips through the URL and produces the expected result set for all three states; confirm selection, "Select all (loaded)", opening the panel, editing a field (including toggling Hidden), and confirming the search results refresh after dismiss.
