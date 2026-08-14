// TVMapCameraController.swift
//
// Pure Siri Remote camera-control math for the tvOS map screen (#2833).
// tvOS has no pan/pitch/rotate gestures (design doc §"Apple TV front-end"),
// so the camera is stepped EXPLICITLY: a directional remote press pans the
// center by a fraction of the current span, and a zoom step scales the
// span up/down. Framework-free (no MapKit/SwiftUI import) — same
// discipline as `MapViewport`, so this is both unit-testable without a
// running focus engine and importable straight into the Maple TV target,
// which cannot link MapleCore.

import Foundation

/// One Siri Remote directional swipe, mapped onto a compass direction on
/// the (north-up) map. tvOS's `MoveCommandDirection` has no diagonals, so
/// neither does this.
public enum TVMapPanDirection: Sendable, Equatable {
  case up, down, left, right
}

public enum TVMapCameraController {
  /// Fraction of the CURRENT span a single directional step pans the
  /// camera center by. Proportional (not a fixed degree amount) so a step
  /// covers the same fraction of the visible map whether zoomed out to a
  /// continent or in to a street.
  public static let panStepFraction: Double = 0.35

  /// Multiplicative zoom step — halves the span per zoom-in press, doubles
  /// it per zoom-out press.
  public static let zoomStepFactor: Double = 0.5

  /// Narrowest allowed span, in degrees. Matches `MapViewport.zoomLevel`'s
  /// own ceiling of zoom 21 (`360 / 2^21`), so repeatedly zooming in caps
  /// out exactly where the server-side zoom clamp does, rather than the
  /// region drifting to a level the server would clamp anyway.
  public static let minSpanDegrees: Double = 360.0 / 2_097_152 // 2^21

  /// Widest allowed longitude span — the whole world in one tile, matching
  /// `MapViewport.bbox(for:)`'s own `longitudeDelta < 360` short-circuit.
  public static let maxLongitudeSpanDegrees: Double = 360

  /// Widest allowed latitude span — pole to pole.
  public static let maxLatitudeSpanDegrees: Double = 180

  /// The camera's starting region when the map screen first appears: a
  /// wide, roughly-whole-world view (longitude span pinned to the
  /// `bbox(for:)` "whole world" threshold) rather than an arbitrary guess,
  /// so the very first fetch already returns whatever the library has.
  public static let defaultRegion = MapViewportRegion(
    centerLatitude: 20, centerLongitude: 0,
    latitudeDelta: 140, longitudeDelta: 360)

  /// Steps `region`'s center by `panStepFraction` of its own span in the
  /// given direction, clamping latitude to the valid range and wrapping
  /// longitude back into `[-180, 180]` — span is unchanged.
  public static func panned(_ region: MapViewportRegion, direction: TVMapPanDirection) -> MapViewportRegion {
    let dLat = region.latitudeDelta * panStepFraction
    let dLng = region.longitudeDelta * panStepFraction
    switch direction {
    case .up:
      return recentered(region, latitude: region.centerLatitude + dLat, longitude: region.centerLongitude)
    case .down:
      return recentered(region, latitude: region.centerLatitude - dLat, longitude: region.centerLongitude)
    case .left:
      return recentered(region, latitude: region.centerLatitude, longitude: region.centerLongitude - dLng)
    case .right:
      return recentered(region, latitude: region.centerLatitude, longitude: region.centerLongitude + dLng)
    }
  }

  /// Halves both deltas (clamped at `minSpanDegrees`) — center unchanged.
  public static func zoomedIn(_ region: MapViewportRegion) -> MapViewportRegion {
    zoomed(region, factor: zoomStepFactor)
  }

  /// Doubles both deltas (clamped at the max span constants) — center
  /// unchanged.
  public static func zoomedOut(_ region: MapViewportRegion) -> MapViewportRegion {
    zoomed(region, factor: 1 / zoomStepFactor)
  }

  private static func zoomed(_ region: MapViewportRegion, factor: Double) -> MapViewportRegion {
    MapViewportRegion(
      centerLatitude: region.centerLatitude,
      centerLongitude: region.centerLongitude,
      latitudeDelta: clamp(region.latitudeDelta * factor, min: minSpanDegrees, max: maxLatitudeSpanDegrees),
      longitudeDelta: clamp(region.longitudeDelta * factor, min: minSpanDegrees, max: maxLongitudeSpanDegrees))
  }

  private static func recentered(_ region: MapViewportRegion, latitude: Double, longitude: Double) -> MapViewportRegion {
    MapViewportRegion(
      centerLatitude: clamp(latitude, min: -90, max: 90),
      centerLongitude: MapViewport.wrapLongitude(longitude),
      latitudeDelta: region.latitudeDelta,
      longitudeDelta: region.longitudeDelta)
  }

  private static func clamp(_ value: Double, min lower: Double, max upper: Double) -> Double {
    Swift.min(Swift.max(value, lower), upper)
  }
}
