// src/apple/Maple TV/TVMapScreen.swift
//
// tvOS Map screen (Map T8, #2833). Same `/api/map/clusters` data pipeline
// as macOS/iOS's native Map (`Maple/Views/Map/MapView.swift`, #2830) —
// `MapViewModel` / `MapClustersClient` / `MapViewport` / `MapAnnotationItem`
// all live in MapleCloudKit precisely so this target (which cannot link
// MapleCore/RawPipeline) reuses them as-is instead of forking a parallel
// copy.
//
// MapKit owns the camera here; this screen does NOT drive it (#2858).
//
// #2833 originally hand-rolled a camera: a focusable full-screen "pad", a
// screen-level `.onMoveCommand` that stepped the region, and
// `.onPlayPauseCommand` to zoom out. That was built on the premise that tvOS
// has no map interaction — a premise taken from the SDK showing
// `rotateEnabled`, `pitchEnabled`, `showsZoomControls`, `showsCompass` and
// callout taps all `API_UNAVAILABLE(tvos)`. Those really are unavailable, but
// SwiftUI's `Map` ships its own tvOS interaction regardless (the Play/Pause
// mode menu), so the hand-rolled layer ended up fighting it: two cameras
// driving one map. Worse, the map was mounted with `position: .constant(...)`,
// a read-only binding, so MapKit's camera movements could never write back
// into our state — `onChange(of: region)` never fired for a user zoom and the
// clusters silently never refetched.
//
// So:
//
//   - MapKit's built-in tvOS interaction pans and zooms. There is no camera
//     pad, no `.onMoveCommand`, and no `.onPlayPauseCommand` on this screen.
//   - `.onMapCameraChange(frequency: .onEnd)` reports the REAL camera, and is
//     the single trigger for refetching clusters. Reading the actual camera
//     rather than a value we wrote is what makes "more pins as you zoom in"
//     work at all.
//   - Each visible pin/cluster (`TVMapAnnotationButton`) is a REAL focusable
//     `Button`, so tvOS's focus engine moves between them natively.
//   - Selecting a focused pin/cluster navigates to `SearchScreen`, preset
//     with the cell's resolved `MapPlaceSearchTarget` — the same
//     place-name-first, has-GPS-scope-fallback chain macOS/iOS use
//     (`MapPlaceSearchTarget.apply(to:)`, shared in MapleCloudKit).
//
// Wrapped in `MapReader` (Map T9, #2834) so `TVMapHeatmapLayerView` can draw
// the heatmap density overlay in sync with the live camera — same reasoning
// as macOS/iOS's `MapView.swift`: SwiftUI's `Map` has no way to host a real
// `MKOverlay`/`MKOverlayRenderer` on tvOS either (verified against the tvOS
// 26.4 SDK — see that file's header), and `MapProxy` is the supported
// alternative. There are two camera-change listeners as a result, and the
// split matters: `.continuous` keeps `currentRegion` (and so the heatmap's
// re-projection) aligned with the tiles DURING a pan, while `.onEnd` keeps the
// expensive cluster refetch to once per gesture. Both only ever READ the
// camera — neither writes it — so #2858's invariant that MapKit alone owns the
// tvOS camera still holds.
//
// Scoped to `libraryID` (unlike macOS/iOS's account-wide Map, which
// replaces the whole library selection): every other TV content screen
// (`TimelineScreen`, `SearchScreen`) is scoped the same way inside
// `RootTabView`, and TV has no per-account "no library selected" state to
// fall into the way the desktop sidebar's MAP row does.

import CoreLocation
import MapKit
import MapleCloudKit
import SwiftUI

struct TVMapScreen: View {
  let session: TVCloudSession
  let libraryID: String

  @State private var viewModel: MapViewModel
  @State private var searchPresentation: TVMapSearchPresentation?
  /// The camera MapKit last settled on, as reported by
  /// `.onMapCameraChange(frequency: .continuous)` below — the only writer,
  /// and continuous so the heatmap stays geographically aligned mid-pan. Drives
  /// `currentZoomLevel` for the heatmap's crossfade; read-only from the
  /// heatmap's point of view, matching #2834's "reads cells and the current
  /// camera; never moves the camera" contract.
  @State private var currentRegion: MKCoordinateRegion?
  @Namespace private var focusNamespace

  init(session: TVCloudSession, libraryID: String) {
    self.session = session
    self.libraryID = libraryID
    _viewModel = State(initialValue: MapViewModel(
      server: session.server,
      client: session.mapClient,
      filter: SearchParams(libraryID: libraryID)
    ))
  }

  /// Deterministic reading-order projection of the current fetch — every
  /// `ForEach` below iterates this, not `viewModel.cells` directly, so
  /// render order, default-focus choice, and (if the platform ever needs
  /// it) any tie-break are all driven from the same ordering.
  private var orderedItems: [MapAnnotationItem] {
    TVMapFocusOrder.ordered(MapAnnotationItem.items(from: viewModel.cells))
  }

  /// Where the camera STARTS. MapKit owns it from then on — this is passed as
  /// `initialPosition`, never re-driven, so a user pan/zoom is not fought by a
  /// value this screen keeps rewriting.
  private static let initialCameraPosition: MapCameraPosition = .region(
    MKCoordinateRegion(
      center: CLLocationCoordinate2D(latitude: 20, longitude: 0),
      span: MKCoordinateSpan(latitudeDelta: 140, longitudeDelta: 360)))

  /// Same zoom convention `MapViewModel.fetch` uses to build the
  /// `/api/map/clusters` `zoom` param — single source of truth so the
  /// heatmap's crossfade lines up with the data the map is actually
  /// showing. `0` (fully opaque, matching a whole-world view) before the
  /// first camera report lands — harmless, since `viewModel.heatmapPoints`
  /// is empty then too.
  private var currentZoomLevel: Int {
    guard let currentRegion else { return 0 }
    return MapViewport.zoomLevel(for: MapViewportRegion(currentRegion))
  }

  var body: some View {
    // Resolved ONCE per body evaluation. `orderedItems` maps every cell and
    // sorts the result, and it used to be read from inside the `ForEach` for
    // the default-focus comparison — so the sort ran once per pin, turning an
    // O(n log n) computation into O(n² log n) on a dense map.
    let items = orderedItems
    let defaultFocusID = items.first?.id

    MapReader { proxy in
      ZStack {
        MapleTVTheme.background.ignoresSafeArea()

        Map(initialPosition: Self.initialCameraPosition) {
          ForEach(items) { item in
            Annotation(item.id, coordinate: CLLocationCoordinate2D(latitude: item.latitude, longitude: item.longitude)) {
              TVMapAnnotationButton(
                item: item,
                server: session.server,
                thumbClient: session.thumbClient,
                thumbCache: session.thumbCache,
                isDefaultFocusTarget: item.id == defaultFocusID,
                focusNamespace: focusNamespace,
                onSelect: { activate(item) }
              )
            }
          }
        }
        // Muted + no POIs: the base map is a backdrop for the pins, not the
        // content. `.muted` desaturates it so photo thumbnails and cluster
        // bubbles are the brightest thing on a big screen in a dim room, and
        // dropping points of interest removes restaurant/shop labels that
        // compete with the pins for attention. The map renders dark because
        // `MapleTVApp` sets `.preferredColorScheme(.dark)` app-wide.
        .mapStyle(.standard(emphasis: .muted, pointsOfInterest: .excludingAll))
        .accessibilityIdentifier("tv-map-view")

        TVMapHeatmapLayerView(points: viewModel.heatmapPoints, zoomLevel: currentZoomLevel, proxy: proxy)

        if viewModel.isEmpty {
          statePane(icon: "mappin.slash", title: "No photos with location here",
                    detail: "Pan or zoom to a different area, or check your active filters.")
        } else if let error = viewModel.loadError, viewModel.cells.isEmpty {
          statePane(icon: "wifi.exclamationmark", title: "Couldn't load photo locations",
                    detail: error.localizedDescription)
        }

        if viewModel.isLoading {
          ProgressView()
            .tint(MapleTVTheme.textPrimary)
            .padding(20)
            .background(MapleTVTheme.surface, in: RoundedRectangle(cornerRadius: 16))
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
            .allowsHitTesting(false)
        }
      }
      // Shared focus scope for the pins' `.prefersDefaultFocus(_:in:)`, so it
      // wraps their common ancestor rather than just the `Map`.
      .focusScope(focusNamespace)
      // `currentRegion` must track the camera CONTINUOUSLY, not just at rest.
      // The heatmap re-projects its points through `proxy.convert` on each
      // `Canvas` evaluation, and the Canvas only re-evaluates when something it
      // reads changes — so if this were only written `.onEnd`, the heat blobs
      // would stay pinned to the screen while the map tiles slid underneath,
      // losing geographic alignment for the whole duration of a pan and
      // snapping back at the end. macOS/iOS already drive their heatmap this
      // way (`MapView.swift`); TV matches so the two don't diverge.
      //
      // Observing the camera continuously is NOT the same as driving it: this
      // only reads, so #2858's invariant — MapKit alone owns the camera — holds.
      .onMapCameraChange(frequency: .continuous) { context in
        currentRegion = context.region
      }
      // Refetching stays on `.onEnd`: it is the expensive half, and settling
      // once per gesture is the point. `MapViewModel` debounces and
      // generation-guards on top, so an in-flight response from an older camera
      // can't overwrite a newer one.
      .onMapCameraChange(frequency: .onEnd) { context in
        viewModel.regionChanged(MapViewportRegion(context.region))
      }
      .fullScreenCover(item: $searchPresentation) { presentation in
        SearchScreen(session: session, libraryID: libraryID, initialParams: presentation.params)
      }
    }
  }

  // MARK: - Pin selection → place search

  /// Builds the search preset from the map's OWN active filter (so a pin
  /// tap narrows date range / camera / etc. rather than discarding it) plus
  /// the tapped cell's resolved target, then presents `SearchScreen` with
  /// it — mirrors `AppShell+Map.swift.selectMapPlace` on macOS/iOS.
  private func activate(_ item: MapAnnotationItem) {
    var params = viewModel.filter
    item.searchTarget.apply(to: &params)
    searchPresentation = TVMapSearchPresentation(params: params)
  }

  // MARK: - Empty / error state

  private func statePane(icon: String, title: String, detail: String) -> some View {
    VStack(spacing: 16) {
      Image(systemName: icon)
        .font(.system(size: 56))
        .foregroundStyle(MapleTVTheme.textMuted)
        .accessibilityHidden(true)
      Text(title)
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(MapleTVTheme.textPrimary)
      Text(detail)
        .font(.system(size: 20))
        .foregroundStyle(MapleTVTheme.textMuted)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 640)
    }
    .padding(48)
    .background(MapleTVTheme.surface, in: RoundedRectangle(cornerRadius: 20))
    // The map keeps panning underneath — informational overlay, not modal
    // (design doc: "the map still pans").
    .allowsHitTesting(false)
  }
}

/// `.fullScreenCover(item:)` presentation payload — `MapPlaceSearchTarget`
/// has already been folded into the preset `SearchParams` by the time this
/// is created (see `activate(_:)`), so the cover itself only needs an
/// identity to present against.
private struct TVMapSearchPresentation: Identifiable {
  let id = UUID()
  let params: SearchParams
}

// No `#Preview` here: `TVCloudSession` builds a real `AuthenticatedHTTPClient`
// with no lightweight `.preview()` factory — matching `SearchScreen`,
// `ConnectedScreen`, and `TimelineScreen`, none of which carry a `#Preview`
// for the same reason.
