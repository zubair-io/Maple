// src/apple/Maple TV/TVMapScreen.swift
//
// tvOS Map screen (Map T8, #2833). Same `/api/map/clusters` data pipeline
// as macOS/iOS's native Map (`Maple/Views/Map/MapView.swift`, #2830) —
// `MapViewModel` / `MapClustersClient` / `MapViewport` / `MapAnnotationItem`
// all live in MapleCloudKit precisely so this target (which cannot link
// MapleCore/RawPipeline) reuses them as-is instead of forking a parallel
// copy.
//
// tvOS has no pan/pitch/rotate gestures and no cursor (design doc §"Apple
// TV front-end"), so the camera is driven EXPLICITLY rather than through
// `Map`'s own gesture handling (there is none here):
//
//   - A screen-filling, focusable "camera pad" (`cameraPad`) sits behind
//     the pins, so there is always something focusable to hold focus and
//     a Select target that zooms IN a step (`zoomedIn`).
//   - `.onMoveCommand` is attached to the whole screen (the ZStack), NOT to
//     the pad, and steps the camera via
//     `TVMapCameraController.panned(_:direction:)` — pure region math, unit
//     tested without any running focus engine. It has to live on the pins'
//     and pad's common ancestor: SwiftUI bubbles unhandled responder events
//     to ancestors and never to siblings, so a pad-mounted handler never saw
//     swipes made while a pin held focus.
//   - `.onPlayPauseCommand`, attached to the whole screen (a dedicated
//     hardware button, so it fires no matter which subview currently holds
//     focus) zooms OUT a step. This is this screen's own reading of the
//     ticket's "the select/play button zooms": Select is CONTEXTUAL here
//     (zoom in when the pad has focus, activate a pin when a pin has
//     focus — see below), so zooming back out needs a control that isn't
//     also a pin's activation button, and Play/Pause is otherwise idle on
//     this screen.
//   - Each visible pin/cluster (`TVMapAnnotationButton`) is a REAL
//     focusable `Button`. tvOS's focus engine moves focus onto one
//     directly when a swipe points at its on-screen position — ordinary
//     tvOS behavior for any focusable sibling, needing no custom code
//     here — falling through to the screen-level `.onMoveCommand` only
//     when there's no pin in that direction. So "moving focus between
//     annotations" and "panning the empty map" fall out of the SAME swipe
//     input without this screen picking one over the other itself.
//   - Selecting a focused pin/cluster navigates to `SearchScreen`, preset
//     with the cell's resolved `MapPlaceSearchTarget` — the same
//     place-name-first, has-GPS-scope-fallback chain macOS/iOS use
//     (`MapPlaceSearchTarget.apply(to:)`, shared in MapleCloudKit).
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
  @State private var region: MapViewportRegion = TVMapCameraController.defaultRegion
  @State private var searchPresentation: TVMapSearchPresentation?
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

  private var cameraPosition: MapCameraPosition {
    .region(MKCoordinateRegion(
      center: CLLocationCoordinate2D(latitude: region.centerLatitude, longitude: region.centerLongitude),
      span: MKCoordinateSpan(latitudeDelta: region.latitudeDelta, longitudeDelta: region.longitudeDelta)))
  }

  var body: some View {
    // Resolved ONCE per body evaluation. `orderedItems` maps every cell and
    // sorts the result, and it used to be read from inside the `ForEach` (for
    // the default-focus comparison) as well as by `cameraPad` — so the sort ran
    // once per pin plus twice more, turning an O(n log n) computation into
    // O(n² log n) on a dense map.
    let items = orderedItems
    let defaultFocusID = items.first?.id

    ZStack {
      MapleTVTheme.background.ignoresSafeArea()

      cameraPad(prefersDefaultFocus: items.isEmpty)

      Map(position: .constant(cameraPosition)) {
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
      .mapStyle(.standard)
      .accessibilityIdentifier("tv-map-view")

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
    // Shared focus scope: `cameraPad` and each pin (`TVMapAnnotationButton`)
    // both use `.prefersDefaultFocus(_:in: focusNamespace)` against this
    // SAME namespace, so it has to wrap their common ancestor (this whole
    // ZStack), not just the `Map` — otherwise the pad's own default-focus
    // preference has no scope to register into.
    .focusScope(focusNamespace)
    // Directional swipes are handled HERE, on the pins' and pad's common
    // ancestor — NOT on `cameraPad`. SwiftUI bubbles an unhandled responder
    // event to its ANCESTORS, never to siblings, and `cameraPad` is a sibling
    // of `Map` inside this ZStack. With the pad owning `.onMoveCommand`, a
    // swipe made while a pin held focus with no pin in that direction bubbled
    // pin → Annotation → Map → ZStack and never reached the pad, leaving the
    // user stuck on the pin unable to pan. `onMoveCommand` fires only for
    // moves the focus engine did not itself consume, so pin-to-pin focus
    // navigation is unaffected — only the leftover swipes pan the camera.
    .onMoveCommand(perform: pan)
    .onPlayPauseCommand(perform: zoomOut)
    .task { viewModel.regionChanged(region) }
    .onChange(of: region) { _, newRegion in viewModel.regionChanged(newRegion) }
    .fullScreenCover(item: $searchPresentation) { presentation in
      SearchScreen(session: session, libraryID: libraryID, initialParams: presentation.params)
    }
  }

  // MARK: - Camera pad

  /// Invisible, screen-filling focusable surface behind the pins. Its Select
  /// action zooms in. Panning is handled by the ZStack, not here — see the
  /// `.onMoveCommand` comment there for why a sibling can't catch it.
  ///
  /// `prefersDefaultFocus` is passed in rather than read from `orderedItems`
  /// so the ordered list is computed once per body evaluation.
  private func cameraPad(prefersDefaultFocus: Bool) -> some View {
    Button(action: zoomIn) {
      Color.clear
        // `Color` has no intrinsic size — without this the Button's label
        // (and so the button's own focusable/hittable frame) would size to
        // zero rather than spanning the screen behind the pins.
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .focusEffectDisabled()
    .prefersDefaultFocus(prefersDefaultFocus, in: focusNamespace)
    .accessibilityLabel("Map camera. Swipe to pan, press to zoom in.")
    .accessibilityIdentifier("tv-map-camera-pad")
  }

  private func pan(_ direction: MoveCommandDirection) {
    guard let mapped = Self.panDirection(for: direction) else { return }
    region = TVMapCameraController.panned(region, direction: mapped)
  }

  private func zoomIn() {
    region = TVMapCameraController.zoomedIn(region)
  }

  private func zoomOut() {
    region = TVMapCameraController.zoomedOut(region)
  }

  private static func panDirection(for direction: MoveCommandDirection) -> TVMapPanDirection? {
    switch direction {
    case .up: return .up
    case .down: return .down
    case .left: return .left
    case .right: return .right
    @unknown default: return nil
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
