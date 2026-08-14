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
  /// ±90 — clamp it. Longitude is WRAPPED (not clamped) into `[-180, 180]`:
  /// a region spanning the antimeridian pushes the raw `east` (or `west`)
  /// past that range (e.g. center 179°, span 4° → raw east 181°) — wrapping
  /// it back in is what actually produces `west > east`, the signal the
  /// server treats as an antimeridian-crossing box (same convention the web
  /// MapLibre integration uses for its own bounds). Leaving the raw value
  /// unwrapped would both send an out-of-range longitude on the wire and
  /// never produce `west > east` at all, since `center - halfLng` is always
  /// less than `center + halfLng` before wrapping.
  public static func bbox(for region: MapViewportRegion) -> MapBBox {
    let halfLat = region.latitudeDelta / 2
    let south = max(region.centerLatitude - halfLat, -90)
    let north = min(region.centerLatitude + halfLat, 90)

    // A span of the whole world (or wider) is a degenerate case for the
    // wrap below: at exactly 360° both bounds wrap to the SAME longitude
    // whenever the center isn't 0 (e.g. center 90°, halfLng 180° → west
    // wraps to -90°, east also wraps to -90°), producing a zero-width box
    // instead of "the whole world" — the map would show 0 photos at any
    // off-center full zoom-out. Short-circuit to the literal full range.
    guard region.longitudeDelta < 360 else {
      return MapBBox(west: -180, south: south, east: 180, north: north)
    }

    let halfLng = region.longitudeDelta / 2
    let west = wrapLongitude(region.centerLongitude - halfLng)
    let east = wrapLongitude(region.centerLongitude + halfLng)
    return MapBBox(west: west, south: south, east: east, north: north)
  }

  /// Wraps a longitude into `[-180, 180]`. A single `while` pass suffices
  /// for any realistic span (a region can be at most 360° wide), but the
  /// loop form is correct for arbitrarily large inputs too.
  ///
  /// `public` (not just used internally by `bbox(for:)`): the tvOS camera
  /// controller (`TVMapCameraController`, #2833) re-normalizes a region's
  /// `centerLongitude` after every explicit pan step, so a long Siri-Remote
  /// session panning past the antimeridian doesn't let the center drift to
  /// an ever-growing out-of-range value.
  public static func wrapLongitude(_ lng: Double) -> Double {
    var wrapped = lng
    while wrapped > 180 { wrapped -= 360 }
    while wrapped < -180 { wrapped += 360 }
    return wrapped
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
