# Timeline: single-query fetch + client-side month bucketing

## Problem

The web Timeline view (`TimelineViewComponent` / `TimelineStateService`, self-hosted folder browsing) fetches its Year/Month structure from `GET /api/search/buckets` — a server-side Mongo aggregation — and then fetches each month's photos separately via `GET /api/search` scoped to that month's date range. This two-stage design assumes the interesting content is near "now": the UI renders a bucket list top-down and only starts loading a month's photos once its section scrolls near the viewport.

When a selected folder or library's newest photo is much older than the current date, this doesn't cause a literal server bug (the buckets endpoint correctly omits empty months — it can never return a month with zero matches), but it does mean the UI's month-by-month lazy-fetch model has no way to jump straight to "where the content actually is." Separately, this two-stage design has no equivalent on Apple (Apple's PhotoKit-backed Cloud Timeline is a different feature — a local/cloud sync merge — and does its own client-side bucket union already), so web and Apple have never shared a bucketing approach, and there's no path to bringing a self-hosted-folder Timeline to Apple without re-solving the same two-stage design there.

## Goals

- Replace Timeline's two-stage fetch (buckets aggregation + per-month page fetch) with a single paginated, sorted query, with the Year → Month → folder grouping computed entirely client-side from whatever pages have loaded.
- Eliminate the current failure mode where a folder's actual content isn't the current month, by removing the current-month-shaped assumption from the fetch design — the first page fetched **is** the most recent content in scope, whatever month that turns out to be.
- Simplify the client state machine: no separate bucket-fetch debounce/generation-counter, no per-month generation counters, no per-month fetch concurrency queue.
- Keep the visual behavior (Year/Month headers, per-month folder sub-grouping, DOM virtualization of offscreen months) unchanged from the user's perspective.

## Non-goals

- **Apple parity is not built in this project.** The self-hosted folder Timeline does not exist on Apple today (its original design spec explicitly listed "Apple parity" as a non-goal). This project only changes the web implementation. A follow-up project can port the resulting client-bucketing approach to Apple once it's proven on web.
- **`GET /api/search/buckets` is not modified or removed.** Apple's separate Maple Cloud sync feature (`CloudTimelineViewModel`) depends on it independently of this work. Web's `TimelineViewComponent` simply stops calling it; the route and its Mongo aggregation are untouched.
- **No new backend endpoint or query parameter.** `GET /api/search` is used exactly as it exists today (`sort`, `page`, `limit`, `pathPrefix`, `libraryId`, filters). No cursor/keyset pagination is introduced in this pass.
- **`TimelineScrubberComponent` is removed entirely, not replaced.** There is no click-to-jump-to-month affordance and no passive position indicator in its place — there's no pre-computed histogram left to size or drive one from, and no replacement is in scope.
- **The "N untimed photos hidden" banner is removed, not replaced.** No replacement count query is added.

## Approaches considered

1. **Sequential page/skip pagination + progressive client-side folding (chosen).** Reuse `GET /api/search` unchanged (`sort=captured_desc&page=N&limit=200`). Client accumulates results in arrival order and folds them into Year→Month→folder groups incrementally as pages land. A single bottom-of-list `IntersectionObserver` sentinel triggers "fetch next page," guarded by an in-flight boolean — no concurrency cap needed since pages are strictly sequential. Zero backend changes.
2. **Cursor/keyset pagination** (`after=<captured_at>,<id>` instead of `page`/`skip`). Avoids Mongo's `skip()` cost scaling with page depth on very large libraries. Rejected for now as speculative: it requires a backend change to solve a performance problem that hasn't been observed yet. Worth revisiting if page/skip pagination proves too slow at real scroll depths.
3. **Fetch everything for the filter scope in one shot, no incremental loading.** Simplest possible client, but reintroduces the "load everything into memory" cost the original two-endpoint split existed to avoid — risky for folders/libraries with thousands of photos. Rejected on performance grounds.

## Design

### State (`TimelineStateService`)

Unchanged except adding `sort: 'captured_desc'` to the params bag returned by `params()`. The `pathPrefix`/`owningLibrary`/folder-address-resolution logic shipped in the prior fix (#1823/#1824) is untouched — this project only changes how `TimelineViewComponent` consumes `params()`.

### Component (`TimelineViewComponent`) data flow

1. On mount and on every `(params() | filters)` change (debounced 250ms, same as today): bump a generation counter, clear accumulated state, fetch page 0 of `GET /api/search` with `{ ...params, sort: 'captured_desc', page: 0, limit: 200 }`.
2. Each response's `results` (already sorted `captured_desc` by the server) is folded into an ordered structure — `YearGroup[] → MonthGroup[] → folderGroup[]` — via a single reducer pass over the new page: extend the trailing month group if the next result shares its `(year, month)`, otherwise close it and open a new one. This mirrors the shape `_bucketByFolder` already produces per-month today; the folder-name grouping logic (splitting by the first path segment under `pathPrefix`) is unchanged, just applied per-page instead of per-month-fetch.
3. Track `total` from the response and `loaded` (running count of results folded so far) to know when pagination is exhausted (`loaded >= total`).
4. Render the accumulated groups directly. There is no pre-declared bucket list and no placeholder-height estimate for unloaded content — the rendered list simply ends where loaded data ends, and grows as more pages arrive. This is the standard infinite-scroll pattern.
5. A sentinel element after the last rendered group, observed by one `IntersectionObserver`, triggers fetching `page + 1` when it scrolls into view — guarded by an in-flight boolean and `loaded < total`. This single observer replaces the per-month fetch-margin `IntersectionObserver` and the `MAX_CONCURRENT_MONTH_FETCHES` concurrency queue.
6. DOM virtualization of offscreen months (dropping `<img>` tags to a placeholder `div` once a month's section leaves the viewport, to avoid mounting thousands of nodes) is kept, using the existing visibility `IntersectionObserver` technique — but the placeholder height for a collapsed month is now the section's *actual measured height* (captured once via `ResizeObserver` before it collapses), not an estimate derived from a bucket count, since by the time a month exists in the DOM its true photo count is already known.

### Removed

`buckets`/`bucketsLoading`/`bucketsError` signals and the `SearchService.buckets()` call; `_monthData`'s bucket-seeded initialization; `bucketsGen`/`bucketsDebounce`; `monthGens`; `_enqueueMonthFetch`/`MAX_CONCURRENT_MONTH_FETCHES`/`_monthFetchQueue`; `estimateMonthHeight`; the fetch-margin `IntersectionObserver` (folded into the single next-page sentinel observer); `TimelineScrubberComponent` and its `onScrubberJump` handler (removed entirely, not replaced); the `untimedHint` computed + its template banner.

### Kept

The visibility `IntersectionObserver` and its DOM-virtualization behavior; `_bucketByFolder`'s per-page folder-name-splitting logic; the folder-group collapse/expand state (`_collapsed`); photo click/dblclick handlers and asset hydration (`_hydrate`); thumbnail loading (`_loadThumb`) and its cache.

### Error handling

A failed page fetch sets a `pageError` signal, rendered as a retry affordance at the bottom of the currently-loaded list — there is exactly one fetch frontier to retry, not N months in flight as today. A filter/params change while a page fetch is in-flight bumps the same generation counter used today, so a stale in-flight response is dropped when it resolves after the scope has already changed.

### Testing

- `timeline-state.service.spec.ts`: no behavioral changes expected beyond asserting `params()` includes `sort: 'captured_desc'`.
- `timeline-view.component.spec.ts`: rewritten around the new flow — stub `SearchService.search` to return paged fixtures; assert page-0 renders the correct Year/Month headers; assert scrolling the sentinel into view fetches page 1 and extends the right month group; assert a page whose results span a month boundary splits into two groups correctly; assert retry-on-error re-fetches the same page rather than reloading everything; assert a filter change mid-fetch drops the stale response via the generation counter.
- Manual verification in the dev server: select a folder whose only photos are from years ago (the original reported symptom) and confirm it renders immediately with no month-by-month walk — page 0 is the content, in whatever month it actually falls.

## Follow-up (explicitly out of scope here)

Once this lands and is verified on web, evaluate porting the same client-side-folding approach to a new self-hosted-folder Timeline on Apple (which doesn't have one today), as a separate project with its own design pass — distinct from Apple's existing Maple Cloud sync Timeline, which is untouched by this work.
