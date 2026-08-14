# Photo Map view — design

**Date:** 2026-08-14
**Status:** Approved design, pending implementation
**Platforms:** Web (Angular) + Apple (SwiftUI/MapKit)

## Summary

Add a **Map** view to the photo browser: a third `viewMode` alongside `folder`
and `timeline`, reachable from a new sidebar button under **Timeline**. The map
shows where the user has taken photos.

- **Zoomed out:** a **heatmap** density overlay — see where photos are without
  plotting every one.
- **Zooming in:** MapKit's native **clustering** takes over — count bubbles
  break apart into more, smaller clusters, and once a cluster resolves to a
  single photo it renders as a **thumbnail pin** (a map pin with the photo
  inside it).
- **Clicking a pin/cluster:** navigates to the search view filtered by that
  location's **place name** (`placeQuery`), so the user lands on those photos.

Both platforms render **Apple Maps**: **MapKit JS** on web, native **MapKit**
on Apple. One shared API endpoint feeds pins and heatmap on both.

## Decisions (locked in brainstorming)

| Decision | Choice | Consequence |
| --- | --- | --- |
| Platforms | Web + Apple | Two front-ends, one shared data endpoint |
| Map SDK | Apple Maps everywhere | MapKit JS (web) + MapKit (native); no MapLibre |
| Density view | True heatmap overlay | Custom overlay — MapKit has no built-in heatmap |
| Pin click target | Place-name search (`placeQuery`) | Uses search as it exists today; no new geo query field |

## Existing code this builds on

- **viewMode toggle** — `library-state.service.ts` (`viewMode: 'folder' |
  'timeline'`, `setViewMode`), surfaced by the single Timeline button in
  `self-hosted-sidebar-body.component.html`, rendered by the `@if` branch in
  `self-hosted-browse-content.component.html`. Map is a third member of this
  union — no new route.
- **Geo data already on assets** — `exif.gps: { lat, lng } | null` and a
  reverse-geocoded `place` (with `place.rollups.locality / region /
  country_code`) in `src/api/src/db/schema.ts`. Populated by the EXIF and
  `geocode` worker stages.
- **Search aggregation pattern** — `src/api/src/routes/search/buckets.ts` and
  `facets.ts` are the template for a new location aggregation. `buildFilter`
  (query.ts) is the shared filter builder the map endpoint reuses.
- **Place-name search** — `placeQuery` free-text param (`query.ts`,
  `search.vm.ts`) and the `scope=places` (has-GPS) filter already exist. Pin
  clicks navigate to `/search/advanced` with `placeQuery`.

## Architecture

### 1. Data endpoint (shared by web + native, pins + heatmap)

`GET /api/map/clusters`

Query params:
- `bbox` — `west,south,east,north` viewport bounds.
- `zoom` — integer zoom level; selects the grid cell size.
- all existing search filter params (`q`, `placeQuery`, `scope`, date range,
  camera, etc.) — parsed by the **same** query-schema and passed to the shared
  `buildFilter`, so the map respects whatever the user has filtered to.

Behavior — a Mongo aggregation, mirroring `buckets.ts`:
1. `$match` = `buildFilter(...)` **AND** `exif.gps != null` **AND** inside
   `bbox`.
2. Grid-bucket each point by a zoom-dependent cell size using `$floor` on
   `lat`/`lng` scaled by a per-zoom factor (no geohash dependency — plain
   arithmetic in the pipeline, same shape as the year/month `$group` in
   buckets.ts).
3. `$group` per cell → `count`, centroid (`$avg` lat/lng), and a
   `representativeAssetId` (`$first` after a stable sort).
4. Include, per cell, the representative asset's **place label** (its
   `place.rollups.locality`, falling back to `region` then `country_code`) so a
   pin click can build `placeQuery` without a second request.
5. When a cell's `count == 1`, include the asset's thumbnail key so the client
   can draw the thumbnail pin without a second request.

Response:
`{ cells: [{ lat, lng, count, representativeAssetId, placeLabel, thumbKey? }] }`.

Why server-side grid-bucketing (not shipping raw points): a large library can
hold hundreds of thousands of located photos; bucketing on the server keeps the
payload bounded to the number of visible cells and satisfies the performance
invariant. The same `cells` array drives **both** the heatmap (weight = `count`)
and the clustered pins.

Index: add a compound/2d index supporting the `bbox` range on
`exif.gps.lat`/`exif.gps.lng`.

### 2. MapKit JS token endpoint (web only)

`GET /api/map/token` → a short-lived **ES256 JWT** signed with the Apple Maps
private key, consumed by `mapkit.init({ authorizationCallback })`.

Configuration (per CLAUDE.md "configure via settings, not env vars"):
- **Maps ID** and **Key ID** — DB-backed settings, edited on a settings page.
- **Private key (.p8)** — a secret (secret store / env), never a UI-visible
  setting.

If Apple Maps is **not configured**, `/api/map/token` reports unconfigured and
the web Map view shows a **"Connect Apple Maps"** empty state rather than a
broken map — same spirit as the geocode stage's `pausedOnFirstBoot` (a feature
that needs external credentials must not present as broken before they exist).

Native MapKit needs **no token** (device-level Apple Maps), so this endpoint is
web-only.

### 3. Web front-end (Angular, `maple-common`)

- **MapKit JS integration** — a small service/loader in `maple-common`: injects
  the MapKit JS script, initializes with the token callback (`GET
  /api/map/token`), exposes an Angular-friendly wrapper.
- **`map` viewMode** — widen the `viewMode` union to `'folder' | 'timeline' |
  'map'` (`library-state.service.ts`, `browse-preferences.service.ts`,
  `source-selection.ts`), add a **Map** button under Timeline in
  `self-hosted-sidebar-body.component.html`, add an `@else if (viewMode ===
  'map')` branch rendering `<app-map-view />` in
  `self-hosted-browse-content.component.html`.
- **`map-view` component** — owns the MapKit map instance:
  - Fetches `/api/map/clusters` for the current viewport + search filters;
    re-fetches (debounced) on pan/zoom.
  - Renders **clustered annotations** (native MapKit clustering) — count
    bubbles that split as you zoom; single-photo cells render a **thumbnail
    pin** (custom annotation with the photo thumbnail).
  - Renders the **heatmap** as a canvas overlay synced to the map's pan/zoom,
    weighted by cell `count`, shown at low zoom and faded out as clustering
    takes over.
  - **Pin/cluster click** → resolve the location's place name (from the
    representative asset's `place.rollups.locality`) and
    `router.navigate(['/search/advanced'], { queryParams: { placeQuery } })`.

### 4. Apple front-end (SwiftUI + MapKit)

- Native **`Map`** (MapKit) view reachable from the app's browse mode switch.
- Pulls the same `/api/map/clusters` endpoint for the current viewport + filter.
- **Clustered annotations** via MapKit clustering; single-photo annotations show
  the thumbnail; **heatmap** as a custom `MKOverlay` renderer weighted by
  `count`.
- **Pin tap** → navigate to the app's search filtered by the place name.

## Data flow

```
pan/zoom or filter change
   → map-view computes bbox + zoom
   → GET /api/map/clusters?bbox&zoom&<search filters>
   → aggregation: buildFilter + gps-in-bbox → grid $group → cells[]
   → client renders: heatmap (weight=count) + clustered pins
   → click pin → placeQuery = cell's locality → /search/advanced
```

## Error / empty states

- **Apple Maps not configured (web):** "Connect Apple Maps" empty state; link to
  the settings page. Not an error toast.
- **No located photos in view:** neutral "No photos with location here" state;
  the map still pans.
- **Token fetch failure:** retry with backoff; degrade to the empty state, not a
  blank map.
- **Asset missing `place` on pin click:** fall back to `scope=places` (or the
  region rollup) so the click still lands on a sensible result set rather than
  no-op.

## Testing

- **API** (`bun test`): aggregation returns correct cell counts/centroids for a
  seeded set of GPS points; bbox filtering excludes out-of-view points; search
  filters compose with the map filter; single-count cells carry `thumbKey`.
  Token endpoint signs a verifiable ES256 JWT and reports unconfigured cleanly.
- **Web** (`ng test`): viewMode switches to `map` and renders the branch;
  map-view issues a clusters request with the right bbox/zoom; pin-click
  navigates to `/search/advanced` with the expected `placeQuery`; unconfigured
  token → empty state.
- **Apple** (`swift test` + UITest): clusters decode; annotation clustering
  produces expected groupings; tap navigates to place search.

## Epic decomposition (tickets)

Independent where the dependency graph allows; the API endpoint (T1) unblocks
both front-ends.

1. **T1 · API** — `GET /api/map/clusters` grid-aggregation endpoint (reuses
   `buildFilter`) + `exif.gps` bbox index. *(unblocks T3–T7)*
2. **T2 · API** — `GET /api/map/token` MapKit JS token + Apple Maps settings
   (Maps ID / Key ID as settings, private key as secret) + settings-page
   control. *(web-only; independent of T1)*
3. **T3 · Web** — MapKit JS integration in `maple-common` + `map` viewMode +
   sidebar button + render branch + "Connect Apple Maps" empty state.
   *(depends on T2 for token, T1 for data)*
4. **T4 · Web** — map-view: clustered thumbnail pins, zoom reveal, pin-click →
   place search. *(depends on T3)*
5. **T5 · Web** — heatmap density overlay synced to the map. *(depends on T3)*
6. **T6 · Apple** — native MapKit view: annotations, clustering, pin-tap →
   place search. *(depends on T1)*
7. **T7 · Apple** — native heatmap `MKOverlay`. *(depends on T6)*

Board: **Files** (feature work). Each ticket ships its UI with its backend where
applicable (no API-only PRs). Epic is not "done" until all seven land.

## Out of scope (YAGNI)

- Structured geo/bbox search query field — pin clicks use existing `placeQuery`.
- Timeline/date scrubbing on the map.
- Offline map tiles.
- MapLibre / non-Apple map fallback (a self-hoster without Apple credentials
  gets the "Connect Apple Maps" state, not a second map engine).
