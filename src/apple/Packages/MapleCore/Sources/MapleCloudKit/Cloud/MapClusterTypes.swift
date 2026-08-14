// MapClusterTypes.swift
//
// DTOs for `GET /api/map/clusters` (#2825/#2832). Mirrors the server's wire
// format: one `MapCluster` per zoom-dependent grid cell inside the
// requested bbox. `thumbKey` is present only when `count == 1` — the
// server's convention is that multi-photo cells carry no single
// representative thumbnail, so the client renders a count bubble instead
// (see `MapAnnotationItem`). `thumbKey` is the asset's `abs_path`, the same
// value `CloudThumbClient.thumb(absPath:)` already expects.
//
// Lives in MapleCloudKit (not MapleCore) — the same `cells` response drives
// the macOS/iOS/iPadOS map (#2830), the tvOS map (#2833), and both
// heatmap overlays (#2831/#2834), and the tvOS target cannot link
// MapleCore (which pulls in RawPipeline).

import Foundation

public struct MapCluster: Codable, Equatable, Sendable, Identifiable {
  public let lat: Double
  public let lng: Double
  public let count: Int
  public let representativeAssetId: String
  /// Reverse-geocoded place label for the representative asset — the
  /// server's locality → region → country_code rollup fallback already
  /// collapsed to one string. `nil` when the representative asset has no
  /// place data at all (never geocoded, or geocoding found nothing).
  /// Callers fall back to a has-GPS search scope rather than a no-op on a
  /// tap — see `MapAnnotationItem.searchTarget(placeLabel:)`.
  public let placeLabel: String?
  /// Thumbnail key (the asset's `abs_path`) — present only when
  /// `count == 1`; multi-count cells render as a count bubble instead.
  public let thumbKey: String?

  /// Cells are distinct grid buckets, so the representative asset id is a
  /// stable per-cell identity within one response.
  public var id: String { representativeAssetId }

  public init(lat: Double,
              lng: Double,
              count: Int,
              representativeAssetId: String,
              placeLabel: String? = nil,
              thumbKey: String? = nil) {
    self.lat = lat
    self.lng = lng
    self.count = count
    self.representativeAssetId = representativeAssetId
    self.placeLabel = placeLabel
    self.thumbKey = thumbKey
  }
}

public struct MapClustersResponse: Codable, Sendable {
  public let cells: [MapCluster]

  public init(cells: [MapCluster]) {
    self.cells = cells
  }
}
