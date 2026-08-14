// MapHeatmapPoint.swift
//
// Pure weight-normalization from `/api/map/clusters` cells into heatmap
// draw inputs (#2831). Framework-free (no MapKit/CoreGraphics) — same
// convention as `MapViewport`/`MapAnnotationItem` — so it's usable by every
// Apple map surface, including tvOS's future heatmap (#2834), without
// linking MapleCore.
//
// Weight is each cell's `count` normalized against the hottest cell in the
// CURRENT response (not a fixed denominator) — the heatmap density ramp is
// always relative to what's visible, matching the web heatmap layer's
// `heatmap-weight` (#2829), which likewise interpolates on the visible
// features' `count`.

import Foundation

public struct MapHeatmapPoint: Equatable, Sendable {
  public let latitude: Double
  public let longitude: Double
  /// Normalized `[0, 1]` — `1.0` is the hottest cell in the source response.
  public let weight: Double

  public init(latitude: Double, longitude: Double, weight: Double) {
    self.latitude = latitude
    self.longitude = longitude
    self.weight = weight
  }

  /// Projects every cell in a `/api/map/clusters` response into a weighted
  /// heat point. Empty input (no located photos in view) yields no heat —
  /// callers render nothing rather than a zero-weight blob.
  public static func points(from cells: [MapCluster]) -> [MapHeatmapPoint] {
    guard let hottest = cells.map(\.count).max(), hottest > 0 else { return [] }
    return cells.map { cell in
      MapHeatmapPoint(latitude: cell.lat, longitude: cell.lng, weight: Double(cell.count) / Double(hottest))
    }
  }
}
