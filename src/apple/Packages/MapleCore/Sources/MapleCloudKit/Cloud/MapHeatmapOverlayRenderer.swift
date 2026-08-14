// MapHeatmapOverlayRenderer.swift
//
// Real `MKOverlayRenderer` for the heatmap (#2831) — pairs with
// `MapHeatmapOverlay`. Any classic `MKMapView` host returns this from
// `mapView(_:rendererFor:)`; tvOS's future map (#2834) is the next
// consumer. macOS/iOS (#2830) uses SwiftUI's native `Map`, which can't host
// an arbitrary `MKOverlayRenderer` (see `MapHeatmapLayerView`'s header
// comment in the app target), so its on-screen drawing goes through
// `MapHeatmapPainter` directly instead of through this class — but the
// actual gradient math is the SAME shared `MapHeatmapPainter`, so there is
// exactly one implementation of "how a weighted point becomes a heat blob,"
// not two that could drift apart.
//
// No per-draw allocation: the only per-`draw` work is building a small
// `[MapHeatmapBlob]` (bounded by the number of on-screen cells, which is
// itself bounded by the server's grid-bucketing — see `MapClusterTypes`'s
// header) from `heatOverlay.points`, which itself only changes when the map
// re-fetches. `MapHeatmapPainter.gradient` is built once and reused.

import Foundation
import CoreLocation
import MapKit

public final class MapHeatmapOverlayRenderer: MKOverlayRenderer {
  private let heatOverlay: MapHeatmapOverlay

  public init(overlay: MapHeatmapOverlay) {
    self.heatOverlay = overlay
    super.init(overlay: overlay)
  }

  public override func draw(_ mapRect: MKMapRect, zoomScale: MKZoomScale, in context: CGContext) {
    let opacity = MapHeatmapZoomCrossfade.opacity(forZoomScale: Double(zoomScale))
    guard opacity > 0, zoomScale > 0 else { return }
    // `point(for:)` converts a full-precision MKMapPoint into THIS
    // renderer's local drawing coordinate system (map points, per
    // MKOverlayRenderer's contract) — required rather than using the raw
    // MKMapPoint x/y because the overlay's coordinate origin isn't (0, 0).
    // The desired SCREEN radius is divided by `zoomScale` (screen points
    // per map point) to convert it into that same map-point coordinate
    // system, so the blob's apparent on-screen size stays roughly constant
    // across zoom levels — the same idiom MKPolylineRenderer uses for a
    // constant-width stroke.
    let blobs: [MapHeatmapBlob] = heatOverlay.points.map { heatPoint in
      let mapPoint = MKMapPoint(CLLocationCoordinate2D(latitude: heatPoint.latitude, longitude: heatPoint.longitude))
      let screenRadius = MapHeatmapPainter.radius(forWeight: heatPoint.weight)
      return MapHeatmapBlob(center: point(for: mapPoint), radius: screenRadius / CGFloat(zoomScale), weight: heatPoint.weight)
    }
    MapHeatmapPainter.draw(blobs: blobs, opacity: opacity, in: context)
  }
}
