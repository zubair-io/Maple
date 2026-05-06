# Timeline view (web) — design

**Status:** approved (brainstorming complete, awaiting plan)
**Scope:** `src/api`, `src/web`
**No-touch:** `src/raw-pipeline`, `src/apple`, `docs/sidecar-schema.md`

## 1. Goals

Add a Timeline mode to the web Browse shell that shows photos sorted by EXIF capture date, grouped by Year → Month → folder, with a recursive folder scope and a lightweight filter row. The folder tree and filename search keep working the same way they do in Folder mode; the centre panel is what swaps.

Concrete user story: "I want to scroll through everything I shot in March 2024, see the shoots grouped together, and narrow it down to picks rated 4★+."

## 2. Non-goals

- **Hosted backend support in v1.** Timeline depends on the Mongo-side EXIF index that only Self-Hosted populates. The toggle is hidden when `backend !== 'self-hosted'`. v2 may add a WASM-walk path if there is demand.
- **Photos without EXIF capture date.** Excluded from the timeline. They remain visible in Folder mode and on `/search`. The Buckets endpoint reports a separate `untimed_count` so the UI can show "N untimed photos hidden — switch to Folder view to see them."
- **A new top-level route.** Timeline lives inside `/browse` as a mode toggle. `/search` stays as the forensic query page.
- **Cross-library "all libraries" mode.** v1 always scopes to a single library root or a subfolder thereof. v2 may add an "All libraries" pseudo-node at the top of the tree.
- **Apple parity.** This is web-only. The native shells get their own timeline design later if/when warranted.

## 3. Decisions log

| # | Decision | Rationale |
|---|---|---|
| D1 | Toggle inside `/browse` shell, not a new route | Folder navigation and detail panel state should follow the user when they flip modes. A separate `/timeline` route would silo state. |
| D2 | Reuse `/api/search`, do not create `/api/timeline` | Timeline is a presentation of search results. One filter contract is easier to keep correct than two. |
| D3 | Hybrid Year → Month → folder grouping | Year/Month gives the time axis the user asked for; folder groups inside each month preserve shoot context (which the user explicitly chose). |
| D4 | Recursive scope from selected tree node | Selecting a library root shows everything in that library; selecting a subfolder narrows to that subtree. Matches user intent. |
| D5 | Add `pathPrefix` filter to `/api/search` | One more filter, same shape as `libraryId`. Useful for the Search page too ("Canon shots in /2018/"). |
| D6 | Add `/api/search/buckets` for year/month counts | Lets the FE pre-size the virtual scroller and render the right-rail scrubber without fetching every photo first. |
| D7 | Exclude no-EXIF photos via `hasCapturedAt=true` query flag | Server-side enforcement so the count and the rows agree. Default off for `/api/search` so the existing Search page behaviour is unchanged. |
| D8 | Lightweight horizontal filter row above the timeline | Folder tree already does scope; toolbar already does filename. The filter row carries the daily-driver culling fields (rating, flag, color, date range). Camera/ISO/etc. live on `/search`. |
| D9 | Self-Hosted only in v1 | Hosted has no Mongo to query; a WASM EXIF-walk is a much larger project. Toggle hidden on Hosted. |
| D10 | Add `abs_path` ascending index | Anchored-prefix `$regex` can use a B-tree index; without one, every Timeline query becomes a collection scan. |

## 4. Architecture

### 4.1 Server (`src/api`)

**Modified file:** [src/api/src/routes/search.ts](src/api/src/routes/search.ts)

- Extend `SearchQuery` with two new fields:
  - `pathPrefix?: string` — anchored prefix on `abs_path`. Validated for length (≤ 1024) and escaped via `escapeRegex` before being passed to Mongo. Translated to `abs_path: { $regex: '^' + escapeRegex(p) }` inside `buildFilter`.
  - `hasCapturedAt?: 'true' | 'false'` — when `'true'`, adds `'exif.captured_at': { $ne: null }`. Default behaviour unchanged.
- Both filters compose with the existing `$or`/`$and` plumbing.
- `pickSort('captured_desc')` already does the right thing as the default for Timeline.

**New endpoint:** `GET /api/search/buckets`

Same query string and `buildFilter` input as `/api/search` and `/api/search/facets`. Response:

```json
{
  "total": 23456,
  "buckets": [
    { "year": 2026, "month": 5, "count": 128 },
    { "year": 2026, "month": 4, "count": 412 },
    { "year": 2025, "month": 12, "count": 1240 }
  ],
  "untimed_count": 84
}
```

Implementation — single Mongo aggregation pipeline:

```js
[
  { $match: applyLiveFilter(filter) },
  { $facet: {
      timed: [
        { $match: { 'exif.captured_at': { $ne: null } } },
        { $project: {
            year:  { $year:  { $dateFromString: { dateString: '$exif.captured_at', onError: null, onNull: null } } },
            month: { $month: { $dateFromString: { dateString: '$exif.captured_at', onError: null, onNull: null } } },
        }},
        { $match: { year: { $ne: null }, month: { $ne: null } } },
        { $group: { _id: { year: '$year', month: '$month' }, count: { $sum: 1 } } },
        { $sort: { '_id.year': -1, '_id.month': -1 } },
      ],
      untimed: [
        { $match: { 'exif.captured_at': null } },
        { $count: 'count' },
      ],
  }},
]
```

The `total` is `sum(timed.count)`, `untimed_count` is `untimed[0].count ?? 0`. Caps the `buckets` array at 600 rows (50 years × 12 months) — anything beyond means a bug, return a 400.

**Modified file:** [src/api/src/db/client.ts](src/api/src/db/client.ts)

Add `assets.createIndex({ abs_path: 1 })` to `ensureIndexes`. Anchored-prefix `$regex` uses this; the existing text index does not. Idempotent so it's safe to ship without a migration.

**Tests** (in [src/api/src/routes/search.test.ts](src/api/src/routes/search.test.ts) — extended):

- `pathPrefix` filters correctly, including special characters in the path (e.g. paths with `(`, `)`, `+`).
- `hasCapturedAt=true` excludes rows where `exif.captured_at` is null or missing.
- `/api/search/buckets` returns expected shape against a hand-rolled fixture set.
- `pathPrefix` plays correctly with `q` (free-text) — both filters AND together, no shadowing of `deleted_at`.
- A path that doesn't exist returns `total: 0`, `buckets: []`, `untimed_count: 0`, status 200.

### 4.2 Frontend (`src/web/projects/maple-common`)

**Shell change:** [browse-shell.component.ts](src/web/projects/maple-common/src/lib/shells/browse-shell/browse-shell.component.ts) and `.html`

- New segmented control in the toolbar (left of the search input): `[ Folder | Timeline ]`. Hidden when `state.backend !== 'self-hosted'`.
- Mode signal `viewMode = signal<'folder' | 'timeline'>('folder')`, persisted under `cm.viewMode` in `localStorage` via `_loadOrDefault`.
- The centre panel becomes:
  ```html
  @if (state.viewMode() === 'folder') {
    <app-asset-grid />
  } @else {
    <app-timeline-view />
  }
  ```
- Folder tree, filename search box, drop-zone import bar, loading/error banners, and detail panel are unchanged.

**New service:** `TimelineStateService` — `src/web/projects/maple-common/src/lib/state/timeline-state.service.ts`

Holds Timeline-specific signals so `LibraryStateService` doesn't grow further.

```ts
@Injectable({ providedIn: 'root' })
export class TimelineStateService {
  // Filters that apply only in Timeline mode.
  readonly minRating = signal<number>(0);
  readonly flag      = signal<'' | 'pick' | 'reject'>('');
  readonly color     = signal<'' | 'red' | 'yellow' | 'green' | 'blue' | 'purple'>('');
  readonly from      = signal<string>('');   // YYYY-MM-DD
  readonly to        = signal<string>('');   // YYYY-MM-DD

  // Derived from LibraryStateService — recursive scope.
  // Walks `sidebarTree` to find the entry whose `id === selectedSourceId()`
  // and returns its `absPath`. null when the selected node is not a
  // filesystem folder (e.g. a section header) — Timeline shows an empty
  // state in that case. Trailing slash is normalised so the regex match
  // doesn't accidentally include a sibling whose name is a prefix
  // (e.g. `/Lib/2026` vs `/Lib/2026-archive`).
  readonly pathPrefix = computed<string | null>(() => /* …walk… */ null);

  // Cached buckets per (pathPrefix, filter hash). Refetched on change with
  // a 250 ms debounce.
  readonly buckets = signal<TimelineBuckets | null>(null);
  // ...
}
```

**New component:** `<app-timeline-view>` — `src/web/projects/maple-common/src/lib/components/timeline-view/`

Files:
- `timeline-view.component.ts`
- `timeline-view.component.html`
- `timeline-view.component.scss`
- `timeline-filter-row.component.ts` — child component for the filter row.
- `timeline-scrubber.component.ts` — child component for the right-rail scrubber.

Layout (top to bottom inside the centre panel):

1. `<timeline-filter-row>` — horizontal row pinned to the top of the centre panel. Contains: rating ★ pills (0–5, 0 = no filter), flag pills (All / Pick / Reject), color swatches (All + 5 swatches), date range (from / to date inputs), a "Clear" link that resets all five filters.
2. The scrolling region — a CDK virtual scroll viewport. Items are flat:
   ```ts
   type TimelineItem =
     | { kind: 'year-header';  year: number;  count: number }
     | { kind: 'month-header'; year: number; month: number; count: number }
     | { kind: 'folder-group-header'; year: number; month: number; folderName: string; count: number; collapsed: boolean }
     | { kind: 'photos-row'; year: number; month: number; folderName: string; results: SearchResult[] };
   ```
   Heights are computed from `buckets` and the count of folder groups within each month.
3. `<timeline-scrubber>` — sticky on the right edge of the viewport, 24 px wide. Renders a vertical strip of months, each cell sized proportionally to its bucket count (clamped between 8 px and 80 px). Hovering shows a tooltip ("May 2026 — 128 photos"); clicking scrolls the viewport to that month.

Data flow:

1. On mount and on every `(pathPrefix | filters)` change (debounced 250 ms):
   - Call `SearchService.buckets({ pathPrefix, hasCapturedAt: 'true', …filters })`.
   - On response, rebuild `timelineItems` with year/month/folder-group placeholders. `folderName` for grouping is the path segment immediately under `pathPrefix` — i.e. `abs_path.slice(pathPrefix.length).split('/')[0]`. Photos that live directly in the prefix (no subfolder) are bucketed under the literal string `'.'` and rendered as "(this folder)". Folder groups within a month are sorted newest-first by their max captured time.
2. As the user scrolls, the virtual scroller emits `viewportChange`. For every visible month that has not been fetched yet:
   - Call `SearchService.search({ pathPrefix, hasCapturedAt: 'true', from: 'YYYY-MM-01', to: 'YYYY-MM-<lastDay>', sort: 'captured_desc', page, limit: 200, …filters })`.
   - Bucket results by `folderName` (computed from `abs_path` minus `pathPrefix`, take the first segment) and emit `photos-row` items.
   - Continue paginating that month until `results.length === bucketCount` or the user scrolls away.
3. Folder-group collapse state is local to the session (a `Map<string, boolean>` keyed by `${year}-${month}-${folderName}`). Not persisted in v1.
4. Selection / focus / detail panel: clicking a thumbnail calls `LibraryStateService.selectAsset(id)` exactly like the asset grid does. The `id` format is `fs:${absPath}`, identical to the Search page's contract. Keyboard shortcuts (1-5, P, X, U, arrows) keep working — the existing handler in `BrowseShell` operates on the focused id regardless of view mode.

**Thumbnail loading:** reuses `FilesystemBrowseService.getThumbBlobUrl(absPath, 512)`. Same blob-URL cache the Search page uses. Thumbnails are loaded lazily as photos enter the viewport, and the cache is shared with Folder mode so flipping back and forth is instant.

**Filename search behaviour:** the existing toolbar `search` input is mapped to `q` for `/api/search` requests in Timeline mode (same as Folder mode would if it were wired up — this keeps a consistent mental model). When `q` is set, results are still grouped by month and folder; an empty month is hidden from the scroller.

### 4.3 Shared types

Add to [src/web/projects/maple-common/src/lib/api/search.service.ts](src/web/projects/maple-common/src/lib/api/search.service.ts):

```ts
export interface TimelineBucket { year: number; month: number; count: number }
export interface TimelineBuckets {
  total: number;
  buckets: TimelineBucket[];
  untimed_count: number;
}

export interface SearchParams {
  // …existing…
  pathPrefix?: string;
  hasCapturedAt?: boolean;   // serialised as 'true'/'false'
}

@Injectable({ providedIn: 'root' })
export class SearchService {
  // …existing search() and facets()…
  buckets(params: Omit<SearchParams, 'page' | 'limit' | 'sort'>): Observable<TimelineBuckets>;
}
```

## 5. Performance budget

The browse-shell budget on a 100k-asset library:

| Action | Target |
|---|---|
| Toggle Folder ↔ Timeline | < 50 ms perceived (same shell, swap centre panel) |
| Buckets request | < 250 ms p95 (one indexed aggregation) |
| First viewport paint after buckets resolve | < 100 ms (placeholders only — heights known) |
| Scroll into a new month, fetch first page | < 400 ms p95 (200 rows, indexed by `exif.captured_at`) |
| Filter change | < 250 ms before the next request fires (debounce) |

The 250-ms debounce on filter changes plus the existing in-flight-generation guard from `SearchComponent` (`searchGen++`) is reused so a slow first request can't overwrite a fast second one.

The `abs_path` index is the load-bearing change for huge libraries — without it, every prefix regex scans the whole collection. With it, `^prefix` queries are a tree range scan.

## 6. Testing

**Server**

- Unit: `buildFilter` cases for `pathPrefix` (regex escape, plays with `$or` from `q`), `hasCapturedAt` (true / false / undefined), composition with all other filters.
- Integration: a hand-rolled Mongo fixture with assets across multiple years, months, and folders. Assertions:
  - Buckets shape matches.
  - `untimed_count` excludes timed rows.
  - `pathPrefix` excludes anything not under the prefix.
  - `pathPrefix='/'` includes everything.
  - Soft-deleted rows are excluded from both `buckets` and counts.
- Index: assert `ensureIndexes()` is idempotent and creates the `abs_path` index.

**Web**

- `TimelineStateService` unit tests for the bucket → flat-item translation.
- `<timeline-view>` component test: given a fixed buckets response, asserts the right number of section headers, folder-group headers, and photo rows are rendered after a scroll event.
- Filter row interaction test: clicking ★4 patches `minRating`, fires a debounced refetch, and the test asserts the request URL contains `rating=4`.
- Toggle test: in Self-Hosted mode the segmented control is visible; in Hosted mode it is not.

**Manual / preview**

Verify in dev (`bun x ng serve maple` against `bun run dev` with a seeded Mongo):
1. Toggle to Timeline; confirm the buckets response renders correct year/month headers.
2. Pick a library root in the tree; confirm scope is recursive (subfolders' photos appear).
3. Pick a subfolder; confirm only that subtree's photos appear.
4. Filter to ★4+ Pick; confirm the buckets re-aggregate and the empty months disappear.
5. Click a thumbnail; confirm the detail panel updates and `Enter` opens the editor.
6. Toggle back to Folder; confirm the tree selection and detail panel state are preserved.

## 7. Out of scope (parking lot)

- All-libraries timeline (no `pathPrefix`, cross-library aggregation).
- "Untimed photos" virtual node in the timeline.
- Sticky day-of-week sub-headers inside long months.
- Mobile-responsive single-column timeline (current shell is desktop-first; phone layout is its own ticket).
- Drag-to-select across the timeline grid.
- Apple parity.

## 8. Files touched

```
src/api/src/routes/search.ts                                        (modified)
src/api/src/routes/search.test.ts                                   (modified)
src/api/src/db/client.ts                                            (modified, +1 index)
src/web/projects/maple-common/src/lib/api/search.service.ts         (modified, new types + buckets())
src/web/projects/maple-common/src/lib/state/timeline-state.service.ts             (new)
src/web/projects/maple-common/src/lib/components/timeline-view/
  ├── timeline-view.component.ts                                    (new)
  ├── timeline-view.component.html                                  (new)
  ├── timeline-view.component.scss                                  (new)
  ├── timeline-filter-row.component.ts                              (new)
  └── timeline-scrubber.component.ts                                (new)
src/web/projects/maple-common/src/lib/shells/browse-shell/
  ├── browse-shell.component.ts                                     (modified, viewMode + import)
  └── browse-shell.component.html                                   (modified, toggle + branch)
src/web/projects/maple-common/src/public-api.ts                     (modified, exports)
```

No `src/raw-pipeline`, `src/apple`, or sidecar-schema changes. No new external dependencies.
