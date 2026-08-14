// MapViewport.swift
//
// Pure geometry translating a map's visible region into the
// `/api/map/clusters` query contract (`bbox=west,south,east,north` +
// `zoom=N`). Deliberately framework-free (no MapKit/CoreLocation import)
// so every Apple map surface can use it, including tvOS (#2833), which
// drives its camera from the focus engine rather than pan/zoom gestures
// but still needs the same region → bbox/zoom translation, and cannot
// link MapleCore.

import Foundation

/// A map viewport expressed the way MapKit's `MKCoordinateRegion` does —
/// center + span — so a SwiftUI `Map` (or a tvOS camera controller) can
/// hand this over without either side needing to import MapKit here.
public struct MapViewportRegion: Equatable, Sendable {
  public let centerLatitude: Double
  public let centerLongitude: Double
  public let latitudeDelta: Double
  public let longitudeDelta: Double

  public init(centerLatitude: Double,
              centerLongitude: Double,
              latitudeDelta: Double,
              longitudeDelta: Double) {
    self.centerLatitude = centerLatitude
    self.centerLongitude = centerLongitude
    self.latitudeDelta = latitudeDelta
    self.longitudeDelta = longitudeDelta
  }
}

/// `west,south,east,north` viewport bounds — the exact shape the `bbox`
/// query parameter serialises.
public struct MapBBox: Equatable, Sendable {
  public let west: Double
  public let south: Double
  public let east: Double
  public let north: Double

  public init(west: Double, south: Double, east: Double, north: Double) {
    self.west = west
    self.south = south
    self.east = east
    self.north = north
  }

  /// `west,south,east,north` — the literal `bbox` query value.
  public var queryValue: String {
    "\(west),\(south),\(east),\(north)"
  }
}

public enum MapViewport {
  /// Half-span bounds around the region's center, clamped to valid
  /// latitude range. A region centered near a pole can push latitude past
  /// ±90 — clamp it. Longitude is left unclamped: a region spanning the
  /// antimeridian legitimately produces `west > east`, which the server
  /// treats as an antimeridian-crossing box (same convention the web
  /// MapLibre integration uses for its own bounds).
  public static func bbox(for region: MapViewportRegion) -> MapBBox {
    let halfLat = region.latitudeDelta / 2
    let halfLng = region.longitudeDelta / 2
    let south = max(region.centerLatitude - halfLat, -90)
    let north = min(region.centerLatitude + halfLat, 90)
    let west = region.centerLongitude - halfLng
    let east = region.centerLongitude + halfLng
    return MapBBox(west: west, south: south, east: east, north: north)
  }

  /// Integer zoom level implied by the region's longitude span, using the
  /// standard web-mercator convention (zoom 0 == the whole 360° world in
  /// one tile: `zoom = log2(360 / longitudeDelta)`). Clamped to `[0, 21]` —
  /// a region can report a span of (or very near) zero at restoration time,
  /// which would send `log2` to infinity.
  public static func zoomLevel(for region: MapViewportRegion) -> Int {
    guard region.longitudeDelta > 0 else { return 21 }
    let raw = log2(360 / region.longitudeDelta)
    guard raw.isFinite else { return 21 }
    return min(max(Int(raw.rounded()), 0), 21)
  }
}
