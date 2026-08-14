# Photo Map view — design

**Date:** 2026-08-14
**Status:** Approved design, in implementation
**Platforms:** Web (Angular) + Apple macOS/iOS/iPadOS (SwiftUI/MapKit) + Apple TV (tvOS)

**Revision 2026-08-14b:** web switched from MapKit JS to **MapLibre GL +
OpenStreetMap**, and **Apple TV** added as a target. See "Revision history" at
the end for what this changed and why.

## Summary

Add a **Map** view to the photo browser: a third `viewMode` alongside `folder`
and `timeline`, reachable from a new sidebar button under **Timeline**. The map
shows where the user has taken photos.

- **Zoomed out:** a **heatmap** density overlay — see where photos are without
  plotting every one.
- **Zooming in:** native **clustering** takes over — count bubbles break apart
  into more, smaller clusters, and once a cluster resolves to a single photo it
  renders as a **thumbnail pin** (a map pin with the photo inside it).
- **Clicking a pin/cluster:** navigates to the search view filtered by that
  location's **place name** (`placeQuery`), so the user lands on those photos.

Each platform uses the map stack idiomatic to it — **MapLibre GL +
OpenStreetMap** on web, native **MapKit** on Apple platforms — over **one**
shared API endpoint that feeds pins and heatmap everywhere.

## Decisions (locked in brainstorming)

| Decision         | Choice                                    | Consequence                                                                             |
| ---------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| Platforms        | Web + Apple (macOS/iOS/iPadOS) + Apple TV | Three front-ends, one shared data endpoint                                              |
| Web map SDK      | **MapLibre GL + OpenStreetMap**           | No Apple credentials needed; works for every self-hoster; tile URL is a DB setting      |
| Apple map SDK    | Native **MapKit**                         | Free, no token, native clustering; shared across macOS/iOS/iPadOS/tvOS                  |
| Density view     | True heatmap                              | **Web: MapLibre's built-in heatmap layer.** Apple: custom `MKOverlay` (MapKit has none) |
| Pin click target | Place-name search (`placeQuery`)          | Uses search as it exists today; no new geo query field                                  |

Why not Apple Maps on web: MapKit JS needs an Apple Developer account, a Maps
ID + private key, and a server-signed JWT per session — a self-hoster without
Apple credentials could not load the map at all. MapLibre + OSM has no such
gate. The cost is that the web map looks different from the native one, which is
acceptable because each is idiomatic to its platform.

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

### 2. Tile source setting (web only)

MapLibre needs a style/tile URL. That URL is a **DB-backed setting** (per
CLAUDE.md "configure via the settings system, not new env vars") with a control
on a settings page, defaulting to a public OpenStreetMap raster source.
Operators who want to self-host tiles or use a commercial provider point the
setting at their own URL — no redeploy, no shell access.

Only **base-map tiles** are fetched from that URL. Photo coordinates never leave
the deployment: pins and heatmap are computed from `/api/map/clusters`, which is
Maple's own endpoint. Worth stating plainly because "does my photo location data
go to a third party" is the obvious operator question, and the answer is no.

No token endpoint and no Apple credentials are required anywhere in the web
path. Native MapKit likewise needs no token (device-level Apple Maps).

### 3. Web front-end (Angular, `maple-common`)

- **MapLibre GL integration** — add `maplibre-gl` as a dependency; a thin
  service in `maple-common` owns map creation/teardown and reads the style URL
  from the tile-source setting. Keep the SDK behind that wrapper so the
  component tree does not import `maplibre-gl` directly.
- **`map` viewMode** — widen the `viewMode` union to `'folder' | 'timeline' |
'map'` (`library-state.service.ts`, `browse-preferences.service.ts`,
  `source-selection.ts`), add a **Map** button under Timeline in
  `self-hosted-sidebar-body.component.html`, add an `@else if (viewMode ===
'map')` branch rendering `<app-map-view />` in
  `self-hosted-browse-content.component.html`.
- **`map-view` component** — owns the MapLibre map instance:
  - Fetches `/api/map/clusters` for the current viewport + search filters;
    re-fetches (debounced) on pan/zoom.
  - Feeds the `cells` array in as a **GeoJSON source** (one feature per cell,
    `count` as a feature property). That single source drives both layers below,
    so pins and heatmap never disagree.
  - **Pins:** a symbol/marker layer — multi-count cells render as count bubbles
    that split into more, smaller bubbles as `zoom` rises (the server returns
    finer cells per zoom level, so "more pins as you zoom in" falls out of the
    data, not out of client-side re-clustering); `count == 1` cells render as a
    **thumbnail pin** (HTML marker showing the photo).
  - **Heatmap:** MapLibre's **built-in `heatmap` layer type**, weighted by the
    `count` property, visible at low zoom and cross-faded out via a
    zoom-interpolated opacity expression as the pin layer takes over.
  - **Pin click** → `router.navigate(['/search/advanced'], { queryParams: {
placeQuery } })` using the cell's `placeLabel`.

### 4. Apple front-end (SwiftUI + MapKit)

- Native **`Map`** (MapKit) view reachable from the app's browse mode switch.
- Pulls the same `/api/map/clusters` endpoint for the current viewport + filter.
- **Clustered annotations** via MapKit clustering; single-photo annotations show
  the thumbnail; **heatmap** as a custom `MKOverlay` renderer weighted by
  `count`.
- **Pin tap** → navigate to the app's search filtered by the place name.

### 5. Apple TV front-end (tvOS)

Verified against the tvOS 26.4 SDK: **`MKMapView` is available on tvOS** (since
tvOS 9.2), as are `MKAnnotationView`, `MKClusterAnnotation`, `MKOverlay` and
`MKOverlayRenderer`. So TV gets the same map, clustering and heatmap building
blocks as the other Apple platforms, and shares the annotation/overlay code with
T6/T7.

What tvOS does **not** have, which drives the design:

- No pan/pitch/rotate gestures, no `showsZoomControls`, no `showsCompass`, no
  callout accessory taps, no annotation dragging.
- There is no cursor and no touch — navigation is the **focus engine** driven by
  the **Siri Remote**.

Consequences:

- **Camera is driven explicitly.** Directional remote input moves the map camera
  in discrete steps and the play/select button zooms, rather than relying on
  gesture recognizers. Region changes are debounced into the same
  `/api/map/clusters` fetch.
- **Pins are focusable items**, not tap targets: moving focus between
  annotations highlights them (with the TV-appropriate focus effect), and
  pressing select activates one.
- **Selecting a pin** navigates to the TV app's search/results surface filtered
  by the cell's `placeLabel` — the same place-name contract as web and iOS.
- **Ten-foot UI:** larger pin/thumbnail sizes and heavier type than the
  touch/pointer platforms.
- Note the TV target **skips MapleCore**, so anything the TV map needs must not
  be introduced as a MapleCore-only dependency.

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

- **Tile source unreachable (web):** the pin/heatmap layers still render over a
  blank base map, with an inline notice pointing at the tile-source setting. The
  photo data is ours and does not depend on the tile server, so a tile outage
  must not blank the feature.
- **No located photos in view:** neutral "No photos with location here" state;
  the map still pans.
- **Cluster fetch failure:** retry with backoff; keep the last good cells
  rendered rather than clearing the map.
- **Cell missing `placeLabel` on pin click:** fall back to `scope=places` (or the
  region rollup) so the click still lands on a sensible result set rather than
  no-op.

## Testing

- **API** (`bun test`): aggregation returns correct cell counts/centroids for a
  seeded set of GPS points; bbox filtering excludes out-of-view points; search
  filters compose with the map filter; single-count cells carry `thumbKey`;
  `placeLabel` fallback chain.
- **Web** (`ng test`): viewMode switches to `map` and renders the branch;
  map-view issues a clusters request with the right bbox/zoom; GeoJSON source
  reflects returned cells; pin-click navigates to `/search/advanced` with the
  expected `placeQuery`; tile-source setting round-trips.
- **Apple** (`swift test` + UITest): clusters decode; annotation clustering
  produces expected groupings; tap navigates to place search. Build **macOS and
  iOS simulator** — "Apple build" means all targets, and a macOS-only build never
  type-checks `#if os(iOS)` paths.
- **Apple TV** (`swift test` + build): focus-driven camera stepping maps remote
  input to expected regions; pin focus/select navigates to place search; build
  the **"Maple TV" scheme** for tvOS.

## Epic decomposition (tickets)

Independent where the dependency graph allows; the API endpoint (T1) unblocks
every front-end.

1. **T1 · API** — `GET /api/map/clusters` grid-aggregation endpoint (reuses
   `buildFilter`) + `exif.gps` bbox index. _(unblocks T3–T9)_
2. **T2 · Web** — tile-source setting (style/tile URL as a DB-backed setting +
   settings-page control), defaulting to public OSM. _(independent of T1)_
3. **T3 · Web** — MapLibre GL integration in `maple-common` + `map` viewMode +
   sidebar button + render branch. _(depends on T2 for the style URL, T1 for
   data)_
4. **T4 · Web** — clustered thumbnail pins, zoom reveal, pin-click → place
   search. _(depends on T3)_
5. **T5 · Web** — heatmap layer (MapLibre built-in `heatmap` type) + zoom
   crossfade. _(depends on T3)_
6. **T6 · Apple** — native MapKit view: annotations, clustering, pin-tap → place
   search. _(depends on T1)_
7. **T7 · Apple** — native heatmap `MKOverlay`. _(depends on T6)_
8. **T8 · Apple TV** — tvOS map view: focus-engine camera control, focusable
   thumbnail pins, select → place search. _(depends on T6 — reuses its
   annotation + DTO code)_
9. **T9 · Apple TV** — tvOS heatmap overlay. _(depends on T7 and T8 — reuses
   T7's `MKOverlayRenderer`)_

Board: **Files** (feature work). Each ticket ships its UI with its backend where
applicable (no API-only PRs). Epic is not "done" until all nine land.

## Out of scope (YAGNI)

- Structured geo/bbox search query field — pin clicks use existing `placeQuery`.
- Timeline/date scrubbing on the map.
- Offline map tiles.
- MapKit JS on web — rejected because it would gate the web map behind an Apple
  Developer account, which a self-hoster may not have.

## Revision history

**2026-08-14b — web moved to MapLibre GL + OpenStreetMap; Apple TV added.**

The original design used Apple Maps on every platform, which on web meant MapKit
JS. That was reversed because MapKit JS requires an Apple Developer account, a
Maps ID and a private key, and would have left self-hosters without Apple
credentials unable to load the map at all. Consequences of the change:

- The MapKit JS **token endpoint was dropped** — no `/api/map/token`, no JWT
  signing, no Apple Maps credential settings, no "Connect Apple Maps" empty
  state. T2 was re-scoped from that endpoint to a simple tile-source setting.
- The **web heatmap got substantially simpler**: MapLibre ships a built-in
  `heatmap` layer type, so T5 is a styled layer over a GeoJSON source rather than
  a hand-rolled canvas overlay synced to the projection. The Apple heatmap (T7)
  is still a custom `MKOverlay` because MapKit has no equivalent.
- **T1 was unaffected** — the clusters endpoint is renderer-agnostic and was
  already implemented against this contract.

Apple TV was added as a target after confirming against the tvOS 26.4 SDK that
`MKMapView`, clustering and overlay rendering are all available there; the
platform's lack of gestures and pointer is handled with focus-engine navigation
(T8/T9).
