# Batch Metadata M2 — Web UI implementation plan

- **Date:** 2026-06-26
- **Ticket:** #1606
- **Epic:** #1575 Batch Metadata Editor
- **Closes:** #1606

## Summary

Adds the web-side Batch Metadata panel and selection-toolbar entry point. Wires into the
existing browse-shell alongside the panorama dialog pattern. Calls `POST /api/xmp/batch`
(M1) and `GET /api/geocode/search?q=` (M1).

---

## New files to create

```
src/web/projects/maple-common/src/lib/batch-metadata/
  batch-metadata.types.ts            -- shared types: MixedValueMap, MIXED sentinel, GeocodeCandidate
  batch-metadata.service.ts          -- computeMixedValues, batchApply, geocodeSearch
  batch-metadata.service.spec.ts     -- unit tests for the service
  batch-metadata-panel.component.ts  -- main panel (standalone, signals)
  batch-metadata-panel.component.html
  batch-metadata-panel.component.scss
  batch-metadata-panel.component.spec.ts
  batch-metadata-confirm-dialog.component.ts
  batch-metadata-confirm-dialog.component.html
  batch-metadata-confirm-dialog.component.scss
```

---

## Existing files to modify

| File | Change |
|---|---|
| `src/web/projects/maple-common/src/lib/shells/browse-shell/browse-shell.component.ts` | Add `canEditMetadata` computed, `onEditMetadata()`, `batchMetaDialogVisible`, `batchMetaAssetPaths`; import `BatchMetadataPanelComponent` |
| `src/web/projects/maple-common/src/lib/shells/browse-shell/browse-shell.component.html` | Add "Edit Metadata…" button next to "Merge to panorama…"; add `<app-batch-metadata-panel>` dialog |
| `src/web/projects/maple-common/src/public-api.ts` | Export the new service and components |

---

## Component structure

### `batch-metadata.types.ts`
- `MIXED = '__mixed__'` — sentinel string for mixed values across selection
- `type MixedOr<T> = T | typeof MIXED`
- `interface MixedValueMap` — one `MixedOr<...>` per `XmpMetadata` field plus `keywords`
- `interface GeocodeCandidate { displayName, lat, lon, address }`
- `interface BatchApplyEntry { path: string; metadata: Partial<XmpMetadata> & { keywords?: string[] } }`
- `interface BatchApplyResult { results: Array<{ path: string; ok: boolean; error?: string }> }`
- `interface AssetMetadataSnapshot { path: string; metadata: Partial<XmpMetadata> & { keywords?: string[] } }`

### `batch-metadata.service.ts`
Injectable `providedIn: 'root'`. Observable-only public API (no async/await).

- `computeMixedValues(snapshots: AssetMetadataSnapshot[]): MixedValueMap` — pure function.
  For each field: if all values equal → that value; else → `MIXED`.
- `batchApply(entries: BatchApplyEntry[]): Observable<BatchApplyResult>` —
  `HttpClient.post('/api/xmp/batch', { entries })`.
- `geocodeSearch(q: string): Observable<GeocodeCandidate[]>` —
  `HttpClient.get<{ suggestions: GeocodeCandidate[] }>('/api/geocode/search', { params: { q } }).pipe(map(r => r.suggestions))`.
  Debounce lives in the **component** (not the service) per the "observables at service layer" rule.

### `batch-metadata-panel.component.ts`

Standalone, `ChangeDetectionStrategy.OnPush`.

Inputs (function-style):
- `assetPaths = input<string[]>([])` — snapshotted absolute paths
- `assetSnapshots = input<AssetMetadataSnapshot[]>([])` — snapshotted metadata per path
- `visible = input<boolean>(false)`

Output:
- `dismiss = output<void>()`

Local state (signals):
- `phase: signal<'form' | 'confirm' | 'applying' | 'done' | 'error'>('form')`
- `mixed: computed(() => service.computeMixedValues(this.assetSnapshots()))` — recomputes on open
- Per-field touched signals: `gpsLatitudeTouched`, etc. — booleans, reset on Reset
- Per-field value signals: one per editable field
- `geocodeQuery = signal<string>('')`
- `geocodeCandidates = signal<GeocodeCandidate[]>([])`
- `geocodeLoading = signal<boolean>(false)`
- `applyErrors = signal<Array<{ path: string; error: string }>>([])` — per-asset failures

Observables live in the constructor (one `takeUntilDestroyed()` subscription for geocode):
```
toObservable(this.geocodeQuery).pipe(
  debounceTime(300),
  filter(q => q.length >= 2),
  switchMap(q => this.svc.geocodeSearch(q)),
  takeUntilDestroyed(),
).subscribe(candidates => this.geocodeCandidates.set(candidates));
```

Key methods:
- `onFieldChange(field, value)` — marks field touched, sets value signal
- `onReset()` — clears all touched flags, resets value signals to mixed/original
- `onApply()` — builds payload from only touched fields, sets phase → 'confirm'
- `onConfirm()` — calls `batchApply`, handles partial errors
- `onCancel()` / `onClose()` → `dismiss.emit()`
- `onGeocodeSelect(candidate)` — sets lat/lon/place-text fields from candidate

Computed:
- `touchedFieldCount = computed(...)` — count of touched fields
- `submitPayload = computed(...)` — array of `BatchApplyEntry`, one per path, only touched fields

Sections (grouped in template):
1. **Capture** — `dateTimeOriginal`, `timeZone` (simplified v1: text fields)
2. **GPS / Location** — address search + candidates dropdown, lat/lon manual fallback, altitude
3. **IPTC Place text** — sublocation, city, state, country, countryCode
4. **Description & cataloging** — title, caption, headline, keywords (add/replace mode), instructions
5. **Creator & rights** — creator, creatorJobTitle, copyrightNotice, copyrightStatus (select), usageTerms, credit, source
6. **Batch culling** — rating (0-5 select), flag (pick/reject/unflagged), colorLabel

### `batch-metadata-confirm-dialog.component.ts`

Standalone, `ChangeDetectionStrategy.OnPush`.

Inputs:
- `visible = input<boolean>(false)`
- `assetCount = input<number>(0)`
- `touchedFields = input<string[]>([])` — human-readable field names
- `applying = input<boolean>(false)`
- `errors = input<Array<{ path: string; error: string }>>([])` — after apply

Outputs:
- `confirm = output<void>()`
- `cancel = output<void>()`

Shows: "N photos will be updated" + list of touched fields. Error state shows per-path failures.

---

## Mixed-value handling

- `MIXED = '__mixed__'` sentinel (typed const)
- `MixedOr<T> = T | typeof MIXED`
- In the template: `@if (mixed().gpsLatitude === MIXED) { (mixed) }` placeholder
- Editing a field always marks it touched and accepts the new value regardless of mixed state
- A touched field that the user clears gets `null` in the payload (explicit clear)

---

## Test strategy

### `batch-metadata.service.spec.ts` (Vitest)
- `computeMixedValues` — uniform values → single value; differing values → `MIXED`; undefined → not set
- `batchApply` — `HttpClientTestingModule` + `HttpTestingController`; verifies POST to `/api/xmp/batch`
- `geocodeSearch` — verifies GET to `/api/geocode/search?q=...`; maps `suggestions`

### `batch-metadata-panel.component.spec.ts` (TestBed + Vitest)
- Renders mixed-value placeholder for a field that differs
- Only touched fields appear in `submitPayload` computed
- `onReset()` clears all touched flags
- Geocode query triggers service call (spy on `BatchMetadataService.geocodeSearch`)

---

## Wiring in browse-shell

Mirror the pano pattern exactly:
1. `readonly batchMetaDialogVisible = signal(false)`
2. `readonly batchMetaAssetSnapshots = signal<AssetMetadataSnapshot[]>([])`
3. `readonly canEditMetadata = computed(() => this.state.selectedCount() >= 1)`
4. `onEditMetadata()` — snapshots selected assets (path + metadata from `assetsInSelectedFolder`)
5. `onBatchMetaDismiss()` — closes dialog, clears snapshots
6. Template: button enabled when `canEditMetadata()`, `(click)="onEditMetadata()"`
7. Template: `<app-batch-metadata-panel [visible]="..." [assetSnapshots]="..." (dismiss)="...">`

---

## Public API barrel additions

```typescript
// #1606 — Batch Metadata web UI (M2)
export * from './lib/batch-metadata/batch-metadata.types';
export * from './lib/batch-metadata/batch-metadata.service';
export * from './lib/batch-metadata/batch-metadata-panel.component';
export * from './lib/batch-metadata/batch-metadata-confirm-dialog.component';
```

---

## File budget

All files are estimated well under the 600-line limit. The panel component is the largest;
if the template grows it splits into section sub-components.

---

## What this plan defers (YAGNI / M3+)

- Backup re-file offer after GPS change → M3
- Date/time shift and anchor modes → beyond M2 scope (v1 ships as text field)
- Keywords add/remove/replace tri-mode → v1 ships as replace (simplest correct)
- Apple UI → M4
- Video sidecar path → M5
