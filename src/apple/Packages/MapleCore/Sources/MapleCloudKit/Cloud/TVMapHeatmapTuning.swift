// TVMapHeatmapTuning.swift
//
// TV-specific size/intensity tuning for the shared heatmap renderer (#2831),
// reused as-is on the tvOS map surface (Map T9, #2834). Kept framework-free
// (only CoreGraphics, for `CGFloat` — the same minimal import
// `MapHeatmapPainter` already takes) and in MapleCloudKit rather than the
// `Maple TV` app target, for the same reason `MapHeatmapZoomCrossfade` and
// `MapHeatmapPoint` are: it's pure, testable math with no SwiftUI/MapKit
// involvement, so `swift test` can exercise it directly instead of only
// through a live TV `Canvas`.
//
// tvOS's base map is `.standard(emphasis: .muted, pointsOfInterest:
// .excludingAll)` — a desaturated dark backdrop — viewed from ~10 feet on a
// big screen instead of at arm's length. Both the blob radius and the
// zoom-crossfade opacity are boosted relative to `MapHeatmapPainter`'s
// handheld defaults (`minScreenRadius`/`maxScreenRadius`, tuned for
// macOS/iOS) to stay legible at that distance. The renderer itself
// (`MapHeatmapPainter`, `MapHeatmapZoomCrossfade`) is NOT forked or
// modified — only the numbers `TVMapHeatmapLayerView` feeds it differ, per
// #2834's explicit "radius/intensity values may legitimately differ from
// the handheld platforms even though the renderer is shared" allowance.

import CoreGraphics

public enum TVMapHeatmapTuning {
  /// ~1.7x `MapHeatmapPainter.minScreenRadius` (24pt) — a lone low-weight
  /// cell still needs to read as a visible blob from across a room, not
  /// just across a desk.
  public static let minScreenRadius: CGFloat = 40
  /// ~1.7x `MapHeatmapPainter.maxScreenRadius` (90pt) — matched to the same
  /// ratio as the floor above, so the size RANGE (not just its endpoints)
  /// still reads as "hotter cells are visibly bigger" at TV distance.
  public static let maxScreenRadius: CGFloat = 150
  /// Multiplies the shared zoom-crossfade opacity before clamping back to
  /// `[0, 1]`. A no-op once the crossfade is already fully opaque (low
  /// zoom, where it's already 1 and can't go higher); its only effect is
  /// mid-fade, where it keeps the heatmap looking "on" longer against the
  /// muted dark base map than the same crossfade value would read against a
  /// brighter handheld map.
  public static let intensityBoost: Double = 1.3

  /// Blob radius for a normalized weight, using the TV bounds above rather
  /// than `MapHeatmapPainter`'s handheld defaults — same underlying
  /// weight→radius interpolation, different endpoints.
  public static func radius(forWeight weight: Double) -> CGFloat {
    MapHeatmapPainter.radius(forWeight: weight, minRadius: minScreenRadius, maxRadius: maxScreenRadius)
  }

  /// The shared zoom crossfade (`MapHeatmapZoomCrossfade.opacity(forZoomLevel:)`),
  /// boosted for TV legibility and re-clamped to a valid opacity.
  public static func opacity(forZoomLevel zoomLevel: Int) -> Double {
    min(MapHeatmapZoomCrossfade.opacity(forZoomLevel: zoomLevel) * intensityBoost, 1)
  }
}
