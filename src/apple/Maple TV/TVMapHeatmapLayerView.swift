// src/apple/Maple TV/TVMapHeatmapLayerView.swift — tvOS SwiftUI bridge for
// the heatmap overlay (Map T9, #2834).
//
// Reuses #2831's `MapHeatmapPainter` (the gradient math) and
// `MapHeatmapZoomCrossfade` (the fade curve) verbatim — the SAME shared
// drawing core `MapHeatmapLayerView` (`Maple/Views/Map/MapHeatmapLayerView.swift`)
// already uses on macOS/iOS. It deliberately does NOT instantiate
// `MapHeatmapOverlay`/`MapHeatmapOverlayRenderer` (the real
// `MKOverlay`/`MKOverlayRenderer` pair #2831 also shipped, for a
// hypothetical classic `MKMapView` host):
//
// Verified against the tvOS 26.4 SDK
// (`_MapKit_SwiftUI.framework`'s `.swiftinterface`) that SwiftUI's `Map` on
// tvOS has the EXACT same limitation macOS/iOS's SwiftUI `Map` has — its
// `MapContent` conformances are Marker/Annotation/MapCircle/MapPolygon/
// MapPolyline only, plus a `mapOverlayLevel(level:)` z-order modifier for
// THOSE types, not a way to host an arbitrary `MKOverlayRenderer`.
// `TVMapScreen` (#2858) hosts its map with SwiftUI's native
// `Map(initialPosition:)`, not a classic `MKMapView` — so
// `MapHeatmapOverlayRenderer` has no host to attach to here either, same as
// macOS/iOS. `MapReader`/`MapProxy` (also available on tvOS) is the
// supported bridge, exactly like `MapHeatmapLayerView`.
//
// `MapHeatmapOverlay`/`MapHeatmapOverlayRenderer` are left unchanged in
// MapleCloudKit for a hypothetical future classic `MKMapView` host — nothing
// here forks a second copy of the drawing math or the crossfade curve; both
// paths call the same `MapHeatmapPainter`/`MapHeatmapZoomCrossfade`.
//
// Ten-foot tuning lives in `TVMapHeatmapTuning` (MapleCloudKit) rather than
// inline here, so it's covered by `swift test` — see that file's header for
// why the radius/opacity numbers diverge from the handheld platforms.
//
// Reuses `MapViewModel.heatmapPoints` via the `points` parameter — no
// second fetch, no parallel data path. Non-interactive: sits above the
// `Map` in z-order but must not steal remote focus from the annotation
// buttons.

import SwiftUI
import MapKit
import MapleCloudKit

struct TVMapHeatmapLayerView: View {
  /// Already-normalized weights straight off `MapViewModel.heatmapPoints`
  /// — see `MapHeatmapLayerView`'s parameter doc for why this is derived
  /// once per fetch (in the view model) rather than inside this draw
  /// closure, which would put an O(n) allocation in the render loop.
  let points: [MapHeatmapPoint]
  let zoomLevel: Int
  /// The live camera. The draw closure never reads it — `proxy.convert`
  /// already projects against the current camera — but it is taken as an input
  /// so SwiftUI has something that actually CHANGES during a pan.
  ///
  /// Without it this view's inputs are effectively constant mid-pan: `points`
  /// only change on a refetch, and `zoomLevel` is a rounded `Int` that holds
  /// steady across a whole pan. SwiftUI would skip re-evaluating the body, the
  /// `Canvas` would never redraw, and the blobs would sit glued to the screen
  /// while the tiles slid underneath — geographically wrong until the gesture
  /// ended, then snapping into place.
  let region: MKCoordinateRegion?
  let proxy: MapProxy

  var body: some View {
    Canvas { context, _ in
      let opacity = TVMapHeatmapTuning.opacity(forZoomLevel: zoomLevel)
      // Cheap rejects first: past the crossfade, or nothing to draw at all.
      // Both skip the projection pass entirely.
      guard opacity > 0, !points.isEmpty else { return }
      context.withCGContext { cgContext in
        MapHeatmapPainter.draw(blobs: heatmapBlobs(), opacity: opacity, in: cgContext)
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  /// Projects the pre-weighted points into screen space for the CURRENT
  /// camera — the only genuinely per-frame work here, since `proxy.convert`
  /// depends on the live camera and its result changes every tick.
  ///
  /// `lazy` so the projected blobs are consumed straight by the painter
  /// without materializing an intermediate array on every draw — same
  /// reasoning as `MapHeatmapLayerView.heatmapBlobs()`.
  private func heatmapBlobs() -> some Sequence<MapHeatmapBlob> {
    points.lazy.compactMap { heatPoint in
      guard let center = proxy.convert(
        CLLocationCoordinate2D(latitude: heatPoint.latitude, longitude: heatPoint.longitude),
        to: .local
      ) else { return nil }
      return MapHeatmapBlob(center: center, radius: TVMapHeatmapTuning.radius(forWeight: heatPoint.weight), weight: heatPoint.weight)
    }
  }
}

/// Live camera state for the heatmap, held in an `@Observable` reference type
/// so the listener and the reader can sit in different places in the tree.
///
/// Both halves of that split are load-bearing:
///
///  - `.onMapCameraChange` only fires when applied to a `Map` or an ANCESTOR of
///    one. The heat layer is a SIBLING of the `Map` inside the screen's
///    `ZStack`, so a listener attached to the layer never fires at all — the
///    same ancestor-not-sibling rule that broke `.onMoveCommand` on the old
///    camera pad (#2858). The listener therefore stays on the ZStack.
///  - Writing that camera into `@State` on the screen would re-evaluate the
///    screen's whole body every frame of a pan, re-running `orderedItems`' sort
///    and rebuilding the `Map` and its annotations at ~60 FPS.
///
/// `@Observable` resolves the tension: only views that actually READ `region`
/// during body evaluation are invalidated when it changes. `TVMapScreen` holds
/// the tracker but never reads it, so it does not rebuild; the heat overlay
/// reads it, so its `Canvas` redraws in step with the tiles.
@Observable
final class TVMapCameraTracker {
  var region: MKCoordinateRegion?
}

/// The heat layer plus the zoom derivation, isolated so that reading the live
/// camera invalidates only this subtree.
struct TVMapHeatmapOverlay: View {
  let points: [MapHeatmapPoint]
  let tracker: TVMapCameraTracker
  let proxy: MapProxy

  /// Same zoom convention `MapViewModel.fetch` uses for the `/api/map/clusters`
  /// `zoom` param, so the crossfade lines up with the data on screen. `0`
  /// (fully opaque, matching a whole-world view) before the first camera report
  /// — harmless, because `points` is empty then too.
  private var zoomLevel: Int {
    guard let region = tracker.region else { return 0 }
    return MapViewport.zoomLevel(for: MapViewportRegion(region))
  }

  var body: some View {
    TVMapHeatmapLayerView(
      points: points, zoomLevel: zoomLevel, region: tracker.region, proxy: proxy)
  }
}
