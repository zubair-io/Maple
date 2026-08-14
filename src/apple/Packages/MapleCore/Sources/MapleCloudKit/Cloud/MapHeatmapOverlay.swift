// MapHeatmapOverlay.swift
//
// Real `MKOverlay` for the heatmap (#2831) — the geometry half of the
// custom overlay the design doc calls for. Holds the already-weighted
// points (`MapHeatmapPoint.points(from:)`) plus the `boundingMapRect`
// MapKit needs to decide when to ask a renderer to draw. Any classic
// `MKMapView` host (tvOS's future map, #2834) can `addOverlay(_:)` this
// directly and pair it with `MapHeatmapOverlayRenderer`.
//
// SwiftUI's native `Map` (macOS/iOS, #2830) cannot host a raw `MKOverlay`
// — see `MapHeatmapLayerView`'s header comment in the app target — so on
// those platforms this type isn't attached to a live map; the SwiftUI
// bridge reads `MapHeatmapPoint.points(from:)` directly instead. It's kept
// here anyway (rather than only where a classic host needs it) because the
// bounding-rect/coordinate math is exactly the kind of "any
// coordinate/projection math" that should be pure and unit-tested next to
// the data it derives from, and because MapKit is available and dependency-
// free-compatible on macOS/iOS/tvOS alike (this target's whole reason to
// exist — see the file header on `MapClusterTypes.swift`).
//
// Lives in MapleCloudKit (not MapleCore) — same reasoning as every other
// file in this folder: the tvOS target cannot link MapleCore.

import Foundation
import CoreLocation
import MapKit

public final class MapHeatmapOverlay: NSObject, MKOverlay {
  public let points: [MapHeatmapPoint]
  public let coordinate: CLLocationCoordinate2D
  public let boundingMapRect: MKMapRect

  public init(points: [MapHeatmapPoint]) {
    self.points = points
    let rect = Self.boundingMapRect(for: points)
    self.boundingMapRect = rect
    self.coordinate = rect.isNull
      ? CLLocationCoordinate2D(latitude: 0, longitude: 0)
      : MKMapPoint(x: rect.midX, y: rect.midY).coordinate
    super.init()
  }

  /// Projects a `/api/map/clusters` response straight into the overlay —
  /// the entry point every map surface uses (`MapHeatmapOverlayRenderer`'s
  /// callers), so nobody re-derives `MapHeatmapPoint.points(from:)` on
  /// their own.
  public static func from(cells: [MapCluster]) -> MapHeatmapOverlay {
    MapHeatmapOverlay(points: MapHeatmapPoint.points(from: cells))
  }

  /// Union of every point's map rect, padded by `paddingFraction` of the
  /// union's own size so a blob centered near the boundary doesn't get
  /// clipped — MapKit only asks a renderer to draw the intersection of
  /// `boundingMapRect` with the visible map rect, so the overlay needs a
  /// little headroom around its tightest-fit bounds. A single point (a
  /// zero-size tight rect) gets a fixed floor pad instead of a
  /// fraction-of-zero. Empty input → `MKMapRect.null` (MapKit never asks a
  /// renderer with a null bounding rect to draw — the "empty cells → no
  /// heat" contract).
  static func boundingMapRect(for points: [MapHeatmapPoint]) -> MKMapRect {
    guard !points.isEmpty else { return .null }
    let mapPoints = points.map { MKMapPoint(CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)) }
    let first = mapPoints[0]
    let tight = mapPoints.dropFirst().reduce(MKMapRect(x: first.x, y: first.y, width: 0, height: 0)) { rect, point in
      rect.union(MKMapRect(x: point.x, y: point.y, width: 0, height: 0))
    }
    let paddingFraction = 0.15
    let minPad = 1_000.0 // map points — a few hundred meters at mid latitudes
    let padX = max(tight.width * paddingFraction, minPad)
    let padY = max(tight.height * paddingFraction, minPad)
    return tight.insetBy(dx: -padX, dy: -padY)
  }
}
