// TVMapFocusOrder.swift
//
// Deterministic focus-traversal order for the tvOS map screen's pin
// annotations (#2833). The server's `/api/map/clusters` cells arrive in
// whatever order the grid-bucket aggregation happens to produce — not
// necessarily a stable reading order — but the Siri Remote focus engine's
// default-focus target needs a well-defined choice, and there is no live
// focus engine in a headless `swift test` run to exercise instead.
// Framework-free (no MapKit/SwiftUI import), matching `MapViewport`'s
// portability discipline.

import Foundation

public enum TVMapFocusOrder {
  /// North-to-south, then west-to-east — the same reading order a map
  /// legend or gazetteer index uses. Ties (identical lat/lng, which the
  /// server's grid-bucketing makes possible for cells sharing a cell
  /// boundary) break on `id` so the order is a strict total order, not
  /// just "usually" stable.
  public static func ordered(_ items: [MapAnnotationItem]) -> [MapAnnotationItem] {
    items.sorted { lhs, rhs in
      if lhs.latitude != rhs.latitude { return lhs.latitude > rhs.latitude }
      if lhs.longitude != rhs.longitude { return lhs.longitude < rhs.longitude }
      return lhs.id < rhs.id
    }
  }

  /// The pin that should hold default focus once pins are on screen — the
  /// first item in reading order, or `nil` when there's nothing to focus
  /// (the camera pad keeps default focus in that case).
  public static func defaultFocusTarget(_ items: [MapAnnotationItem]) -> MapAnnotationItem? {
    ordered(items).first
  }
}
