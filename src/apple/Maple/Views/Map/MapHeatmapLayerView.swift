// MapHeatmapLayerView.swift — SwiftUI bridge for the heatmap overlay (#2831).
//
// SwiftUI's native `Map` (used by MapView.swift, #2830) has no public API
// to host an arbitrary `MKOverlay`/`MKOverlayRenderer` — confirmed against
// the `_MapKit_SwiftUI` SDK interface, whose `MapContent` conformances are
// limited to Marker/Annotation/MapCircle/MapPolygon/MapPolyline (plus a
// `mapOverlayLevel` z-order modifier for those, not a way to add a raw
// overlay). This view bridges the REAL heatmap drawing core
// (`MapHeatmapPainter`, shared verbatim with `MapHeatmapOverlayRenderer` —
// not reimplemented) onto the SwiftUI Map via `MapReader`'s `MapProxy`
// (the supported way to add custom-drawn content synced to the map's live
// camera — see `MapView.swift`) and a `Canvas`, which exposes the real
// `CGContext` through `GraphicsContext.withCGContext`.
//
// tvOS's future classic-`MKMapView` host (#2834) doesn't need this file —
// it can `mapView.addOverlay(MapHeatmapOverlay.from(cells:))` directly and
// return `MapHeatmapOverlayRenderer` from its delegate.
//
// Reuses `MapViewModel.cells` via the `cells` parameter — no second fetch,
// no parallel data path. Non-interactive: sits above the `Map` in z-order
// but must not steal pin taps.

import SwiftUI
import MapKit
import MapleCore

struct MapHeatmapLayerView: View {
  /// Already-normalized weights straight off `MapViewModel.heatmapPoints`
  /// — deliberately NOT the raw `[MapCluster]`. Normalizing here would run
  /// an O(n) max plus an array allocation inside the draw closure below,
  /// which fires on every camera tick; the VM derives this once per fetch
  /// instead (see `MapViewModel.heatmapPoints`).
  let points: [MapHeatmapPoint]
  let zoomLevel: Int
  let proxy: MapProxy

  var body: some View {
    Canvas { context, _ in
      let opacity = MapHeatmapZoomCrossfade.opacity(forZoomLevel: zoomLevel)
      // Cheap rejects first: past the crossfade, or nothing to draw at all.
      // Both skip the projection pass entirely.
      guard opacity > 0, !points.isEmpty else { return }
      let blobs = heatmapBlobs()
      guard !blobs.isEmpty else { return }
      context.withCGContext { cgContext in
        MapHeatmapPainter.draw(blobs: blobs, opacity: opacity, in: cgContext)
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  /// Projects the pre-weighted points into screen space for the CURRENT
  /// camera — the only genuinely per-frame work here, since `proxy.convert`
  /// depends on the live camera and its result changes every tick. Returns
  /// `nil` for a coordinate MapKit can't currently project (effectively
  /// off-map), which this drops rather than propagating.
  private func heatmapBlobs() -> [MapHeatmapBlob] {
    points.compactMap { heatPoint in
      guard let center = proxy.convert(
        CLLocationCoordinate2D(latitude: heatPoint.latitude, longitude: heatPoint.longitude),
        to: .local
      ) else { return nil }
      return MapHeatmapBlob(center: center, radius: MapHeatmapPainter.radius(forWeight: heatPoint.weight), weight: heatPoint.weight)
    }
  }
}
