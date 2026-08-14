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
  let cells: [MapCluster]
  let zoomLevel: Int
  let proxy: MapProxy

  var body: some View {
    Canvas { context, _ in
      let opacity = MapHeatmapZoomCrossfade.opacity(forZoomLevel: zoomLevel)
      guard opacity > 0 else { return }
      let blobs = heatmapBlobs()
      guard !blobs.isEmpty else { return }
      context.withCGContext { cgContext in
        MapHeatmapPainter.draw(blobs: blobs, opacity: opacity, in: cgContext)
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  /// Screen-space blobs for the current camera — `proxy.convert` returns
  /// `nil` for a coordinate MapKit can't currently project (effectively
  /// off-map), which this drops rather than propagating.
  private func heatmapBlobs() -> [MapHeatmapBlob] {
    MapHeatmapPoint.points(from: cells).compactMap { heatPoint in
      guard let center = proxy.convert(
        CLLocationCoordinate2D(latitude: heatPoint.latitude, longitude: heatPoint.longitude),
        to: .local
      ) else { return nil }
      return MapHeatmapBlob(center: center, radius: MapHeatmapPainter.radius(forWeight: heatPoint.weight), weight: heatPoint.weight)
    }
  }
}
