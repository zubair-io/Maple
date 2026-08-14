// MapHeatmapPainter.swift
//
// Allocation-free heat-gradient drawing core (#2831), shared by every
// Apple map surface that hosts the heatmap: the real `MKOverlayRenderer`
// (`MapHeatmapOverlayRenderer` — used by any classic `MKMapView` host,
// including tvOS's future map, #2834) AND the SwiftUI-native `Map`'s bridge
// (`MapHeatmapLayerView` in the app target, used by macOS/iOS, #2830).
// SwiftUI's `Map` has no public API to host an arbitrary `MKOverlayRenderer`
// — confirmed against the `_MapKit_SwiftUI` SDK interface, whose
// `MapContent` conformances are limited to
// Marker/Annotation/MapCircle/MapPolygon/MapPolyline — so the SwiftUI
// bridge draws through `GraphicsContext.withCGContext` into the SAME
// CGContext-level primitives this file uses, rather than reimplementing
// the gradient math twice.
//
// No per-draw allocation: `gradient` is a `static let`, so the Swift
// runtime builds it exactly once, lazily, thread-safely, the first time
// either consumer draws; every `draw` call after that only iterates an
// already-built `blobs` array (built by the caller from its own point
// list, which only changes when the map's cells/camera change, not on a
// timer) and issues `CGContext.drawRadialGradient` calls against the
// shared gradient object.

import CoreGraphics

public struct MapHeatmapBlob: Equatable {
  public let center: CGPoint
  /// Radius in the CALLER's drawing units — map points for the
  /// `MKOverlayRenderer` path (which draws in the overlay's map-point
  /// coordinate system), screen points for the SwiftUI-Canvas path (which
  /// draws in the view's own point space). Each caller converts its own
  /// "how big should this look on screen" intent into whichever unit its
  /// `CGContext` is in.
  public let radius: CGFloat
  /// `[0, 1]` — carried through for callers/tests; the painter itself only
  /// consumes `radius` (already weight-scaled by the caller).
  public let weight: Double

  public init(center: CGPoint, radius: CGFloat, weight: Double) {
    self.center = center
    self.radius = radius
    self.weight = weight
  }
}

public enum MapHeatmapPainter {
  /// Screen-space blob size range shared by both consumers so a cell of a
  /// given weight looks the same size whether it's drawn by the classic
  /// renderer or the SwiftUI bridge.
  public static let minScreenRadius: CGFloat = 24
  public static let maxScreenRadius: CGFloat = 90

  /// Classic heat ramp, center (location 0, `startRadius` in every
  /// `drawRadialGradient` call below) to edge (location 1, `endRadius`):
  /// hot red core → warm yellow → green → cool blue → fully transparent at
  /// the blob's outer edge. Alpha ramps down alongside hue so the edge
  /// blends invisibly rather than tiling into a hard-edged circle. Built
  /// once, on first use.
  public static let gradient: CGGradient = {
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let colors: [CGColor] = [
      CGColor(red: 1.00, green: 0.25, blue: 0.15, alpha: 0.9),
      CGColor(red: 1.00, green: 0.85, blue: 0.20, alpha: 0.75),
      CGColor(red: 0.30, green: 0.85, blue: 0.55, alpha: 0.55),
      CGColor(red: 0.20, green: 0.60, blue: 1.00, alpha: 0.35),
      CGColor(red: 0.20, green: 0.40, blue: 1.00, alpha: 0.0),
    ]
    let locations: [CGFloat] = [0, 0.2, 0.4, 0.65, 1.0]
    guard let gradient = CGGradient(colorsSpace: colorSpace, colors: colors as CFArray, locations: locations) else {
      preconditionFailure("MapHeatmapPainter.gradient: fixed color/location arrays are always valid CGGradient input")
    }
    return gradient
  }()

  /// Radius (in the caller's drawing units) for a normalized weight — the
  /// hottest cell (`weight == 1`) draws at `maxRadius`; every other cell is
  /// still visible at `minRadius` at worst, so a lone low-weight cell never
  /// disappears.
  public static func radius(forWeight weight: Double,
                             minRadius: CGFloat = minScreenRadius,
                             maxRadius: CGFloat = maxScreenRadius) -> CGFloat {
    let clamped = min(max(weight, 0), 1)
    return minRadius + (maxRadius - minRadius) * CGFloat(clamped)
  }

  /// Draws every blob with `.plusLighter` blending (overlapping blobs add
  /// up into a hotter-looking core — the standard heatmap look) at the
  /// given overall opacity (the zoom crossfade). No-op for `opacity <= 0`
  /// — an empty sequence simply draws nothing (the loop never runs).
  ///
  /// Takes a `Sequence` rather than an `Array` specifically so callers can
  /// hand over a `lazy` chain and skip materializing an intermediate
  /// buffer. Blob centers and radii are camera-dependent, so unlike the
  /// gradient they genuinely cannot be precomputed across draws — but they
  /// don't have to be *collected* per draw either.
  public static func draw(blobs: some Sequence<MapHeatmapBlob>, opacity: Double, in context: CGContext) {
    guard opacity > 0 else { return }
    context.saveGState()
    context.setAlpha(CGFloat(opacity))
    context.setBlendMode(.plusLighter)
    for blob in blobs where blob.radius > 0 {
      context.drawRadialGradient(
        gradient,
        startCenter: blob.center, startRadius: 0,
        endCenter: blob.center, endRadius: blob.radius,
        options: [])
    }
    context.restoreGState()
  }
}
