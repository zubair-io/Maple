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
