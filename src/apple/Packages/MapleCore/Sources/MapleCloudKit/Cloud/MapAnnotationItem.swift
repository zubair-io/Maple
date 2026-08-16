// MapAnnotationItem.swift
//
// Pure, framework-free projection from the server's `MapCluster` cells to
// what the map view renders — a thumbnail pin for a single-photo cell, a
// count bubble for everything else — plus the pin-tap → search-filter
// decision. Shared by every Apple map surface (macOS/iOS/iPadOS, #2830;
// tvOS, #2833; the heatmap overlays, #2831/#2834) so none of them
// re-derive this from `MapCluster` on their own.

import Foundation

public struct MapAnnotationItem: Identifiable, Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    /// `count == 1` — render the asset's thumbnail. `thumbKey` is the
    /// `abs_path` `CloudThumbClient.thumb(absPath:)` expects.
    case thumbnail(assetID: String, thumbKey: String)
    /// `count > 1` (or a `count == 1` cell that arrived without the
    /// `thumbKey` the contract promises — see `from(_:)`) — render a
    /// count bubble.
    case cluster(count: Int)
  }

  public let id: String
  public let latitude: Double
  public let longitude: Double
  public let kind: Kind
  /// Carried through from the source cell for the pin-tap search target —
  /// see `searchTarget`.
  public let placeLabel: String?

  public init(id: String, latitude: Double, longitude: Double, kind: Kind, placeLabel: String?) {
    self.id = id
    self.latitude = latitude
    self.longitude = longitude
    self.kind = kind
    self.placeLabel = placeLabel
  }

  /// Projects one server cell into the annotation it renders as.
  public static func from(_ cell: MapCluster) -> MapAnnotationItem {
    let kind: Kind
    if cell.count == 1, let thumbKey = cell.thumbKey {
      kind = .thumbnail(assetID: cell.representativeAssetId, thumbKey: thumbKey)
    } else {
      // Either a genuine multi-photo cell, or (defensively) a count==1
      // cell that arrived without the `thumbKey` the contract promises —
      // a version mismatch shouldn't crash or drop the pin, just fall
      // back to the bubble it'd render if the server saw it as >1.
      kind = .cluster(count: cell.count)
    }
    return MapAnnotationItem(
      id: cell.representativeAssetId,
      latitude: cell.lat,
      longitude: cell.lng,
      kind: kind,
      placeLabel: cell.placeLabel)
  }

  /// Projects every cell in a `/api/map/clusters` response. Order is
  /// preserved — the server already grid-bucketed by zoom, so no
  /// client-side re-clustering happens here (mirrors the web MapLibre
  /// integration, which renders the same `cells` array as-is: "more pins
  /// as you zoom in" falls out of the server's finer cells at that zoom,
  /// not out of client-side regrouping).
  public static func items(from cells: [MapCluster]) -> [MapAnnotationItem] {
    cells.map(from)
  }
}

/// Where a pin/cluster tap should route the user. `.placeQuery` names a
/// resolvable place (feeds `SearchParams.placeQuery`); `.hasLocationScope`
/// is the fallback when a cell carries no place label at all (never
/// geocoded, or geocoding found nothing) — landing on "everything with a
/// location" (`SearchParams.scope = "places"`, the server's `exif.gps !=
/// null` filter) beats a no-op tap.
public enum MapPlaceSearchTarget: Equatable, Sendable {
  case placeQuery(String)
  case hasLocationScope
}

extension MapAnnotationItem {
  /// Pin/cluster tap target, applying the fallback chain from the design
  /// doc's "cell missing `placeLabel`" error state.
  public var searchTarget: MapPlaceSearchTarget {
    Self.searchTarget(placeLabel: placeLabel)
  }

  public static func searchTarget(placeLabel: String?) -> MapPlaceSearchTarget {
    guard let trimmed = placeLabel?.trimmingCharacters(in: .whitespacesAndNewlines),
          !trimmed.isEmpty else {
      return .hasLocationScope
    }
    return .placeQuery(trimmed)
  }
}

extension MapPlaceSearchTarget {
  /// Applies this pin/cluster tap resolution onto a `SearchParams`,
  /// narrowing whatever filter was already active (date range, camera, …)
  /// rather than discarding it back to "everything, everywhere" — the same
  /// fallback chain the design doc's "cell missing `placeLabel`" error
  /// state specifies. Shared by every Apple map surface's pin-tap → search
  /// wiring (macOS/iOS `AppShell+Map.swift.selectMapPlace`, #2830; tvOS
  /// `TVMapScreen`, #2833) so the chain lives in exactly one place.
  public func apply(to params: inout SearchParams) {
    switch self {
    case .placeQuery(let query):
      params.placeQuery = query
    case .hasLocationScope:
      params.scope = "places"
    }
  }

  /// Seeds `SearchParams` from `filter` — the SAME filter the map itself
  /// queried `/api/map/clusters` with — then layers this tap's resolved
  /// place/scope on top via `apply(to:)`, so a pin tap narrows the active
  /// filter (date range, camera, …) rather than discarding it back to
  /// "everything, everywhere." The single composition `selectMapPlace`
  /// (`AppShell+Map.swift`, #2830/#2886) hands to
  /// `activateSearch(server:libraryID:params:)` — pulled out here (rather
  /// than left inline in the `@MainActor` AppShell extension) so it's
  /// covered by a plain `MapleCoreTests` unit test instead of only being
  /// exercisable end-to-end through the app target.
  public func searchParams(seededFrom filter: SearchParams) -> SearchParams {
    var params = filter
    apply(to: &params)
    return params
  }
}
