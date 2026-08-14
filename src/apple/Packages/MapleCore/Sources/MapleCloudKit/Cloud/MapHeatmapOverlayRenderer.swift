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
    guard opacity > 0, zoomScale > 0, !heatOverlay.points.isEmpty else { return }
    // `lazy` so the per-tile blob list is never materialized into an
    // intermediate array — the painter consumes it as a sequence.
    MapHeatmapPainter.draw(
      blobs: heatOverlay.points.lazy.compactMap { self.blob(for: $0, zoomScale: zoomScale, mapRect: mapRect) },
      opacity: opacity,
      in: context)
  }

  /// One point → its blob in this renderer's drawing coordinates, or `nil`
  /// if the blob can't touch `mapRect` at all.
  ///
  /// `point(for:)` converts a full-precision `MKMapPoint` into THIS
  /// renderer's local drawing coordinate system (map points, per
  /// `MKOverlayRenderer`'s contract) — required rather than using the raw
  /// `MKMapPoint` x/y, because the overlay's coordinate origin isn't (0, 0).
  /// The desired SCREEN radius is divided by `zoomScale` (screen points per
  /// map point) to convert it into that same map-point coordinate system, so
  /// the blob's apparent on-screen size stays roughly constant across zoom
  /// levels — the same idiom `MKPolylineRenderer` uses for a constant-width
  /// stroke.
  private func blob(for heatPoint: MapHeatmapPoint,
                    zoomScale: MKZoomScale,
                    mapRect: MKMapRect) -> MapHeatmapBlob? {
    let mapPoint = MKMapPoint(CLLocationCoordinate2D(latitude: heatPoint.latitude, longitude: heatPoint.longitude))
    let radiusMapPoints = Double(MapHeatmapPainter.radius(forWeight: heatPoint.weight)) / Double(zoomScale)
    // MapKit calls draw() once per TILE. Without this cull every tile would
    // issue a full-cost drawRadialGradient for every point in the overlay,
    // even ones far outside the tile, and pay for CoreGraphics to clip them.
    guard MapHeatmapOverlay.blobBounds(center: mapPoint, radiusMapPoints: radiusMapPoints).intersects(mapRect) else {
      return nil
    }
    return MapHeatmapBlob(center: point(for: mapPoint), radius: CGFloat(radiusMapPoints), weight: heatPoint.weight)
  }
}
