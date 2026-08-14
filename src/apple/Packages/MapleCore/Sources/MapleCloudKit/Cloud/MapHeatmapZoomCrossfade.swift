// MapHeatmapZoomCrossfade.swift
//
// Pure zoom-based opacity curve for the heatmap overlay (#2831). The
// heatmap owns the low-zoom (wide) view and fades out as MapKit's clustered
// pins take over at higher zoom — mirroring the web MapLibre heatmap
// layer's `heatmap-opacity` zoom expression (#2829) so both platforms read
// the same. Framework-free (no MapKit import) like `MapViewport`, so
// tvOS's future heatmap (#2834) can reuse it without linking MapleCore.

import Foundation

public enum MapHeatmapZoomCrossfade {
  /// Fully opaque at or below this zoom (same integer convention as
  /// `MapViewport.zoomLevel`) — country/continent-scale views, where
  /// individual pins would be too sparse and small to read as "where are my
  /// photos."
  public static let fadeStartZoom = 4
  /// Fully transparent at or above this zoom — city/neighborhood scale,
  /// where the server's finer per-zoom grid cells (T1) already give
  /// legible clustered pins and the heatmap would just compete visually.
  public static let fadeEndZoom = 10

  /// `1.0` at/below `fadeStartZoom`, linearly down to `0.0` at/above
  /// `fadeEndZoom`.
  public static func opacity(forZoomLevel zoomLevel: Int) -> Double {
    guard zoomLevel > fadeStartZoom else { return 1 }
    guard zoomLevel < fadeEndZoom else { return 0 }
    let span = Double(fadeEndZoom - fadeStartZoom)
    let progress = Double(zoomLevel - fadeStartZoom) / span
    return 1 - progress
  }

  /// `MKZoomScale` (screen points per map point — the value MapKit hands
  /// `MKOverlayRenderer.draw(_:zoomScale:in:)`) converted into the same
  /// integer zoom convention `MapViewport.zoomLevel` uses, so the
  /// overlay renderer's crossfade lines up with the fetch-driving zoom the
  /// rest of the map surface already uses.
  ///
  /// Derived from the standard web-mercator tile convention: the whole
  /// world renders as one `tileSize`-point-wide tile at zoom 0, and is
  /// always `worldMapPointWidth` map points wide (map points are a
  /// fixed-resolution coordinate space, independent of zoom) — so
  /// `zoomScale = (tileSize * 2^zoom) / worldMapPointWidth`, inverted below.
  /// `worldMapPointWidth` is `MKMapSize.world.width`'s value, hardcoded
  /// (rather than importing MapKit) so this file stays framework-free.
  public static func zoomLevel(forZoomScale zoomScale: Double) -> Int {
    guard zoomScale > 0 else { return 0 }
    let worldMapPointWidth = 268_435_456.0
    let tileSize = 256.0
    let raw = log2(zoomScale * worldMapPointWidth / tileSize)
    guard raw.isFinite else { return 0 }
    return min(max(Int(raw.rounded()), 0), 21)
  }

  /// Convenience combining the two — what `MapHeatmapOverlayRenderer` calls
  /// from `draw(_:zoomScale:in:)`.
  public static func opacity(forZoomScale zoomScale: Double) -> Double {
    opacity(forZoomLevel: zoomLevel(forZoomScale: zoomScale))
  }
}
