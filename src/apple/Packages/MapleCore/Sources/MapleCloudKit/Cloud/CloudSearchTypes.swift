// CloudSearchTypes.swift
//
// DTOs for /api/search/buckets and /api/search. Mirrors the server's wire
// format from src/api/src/routes/search.ts. Keep field names exactly as
// the server emits them — these are decoded from raw JSON.

import Foundation

public struct TimelineBucket: Codable, Equatable, Sendable {
  public let year: Int
  public let month: Int
  public let count: Int

  public init(year: Int, month: Int, count: Int) {
    self.year = year; self.month = month; self.count = count
  }
}

public struct TimelineBuckets: Codable, Sendable {
  public let total: Int
  public let buckets: [TimelineBucket]
  public let untimed_count: Int

  public init(total: Int, buckets: [TimelineBucket], untimed_count: Int) {
    self.total = total; self.buckets = buckets; self.untimed_count = untimed_count
  }
}

public struct SearchAssetCamera: Codable, Equatable, Sendable {
  public let make: String?
  public let model: String?
}

/// Reverse-geocode rollup tiers (locality/region/country) for a
/// `SearchAssetPlace`. Mirrors the `rollups` sub-object of the server's
/// `Place` interface (`src/api/src/db/schema.ts`).
public struct SearchAssetPlaceRollups: Codable, Equatable, Sendable {
  public let locality: String?
  public let region: String?
  public let country_code: String?

  public init(locality: String? = nil, region: String? = nil, country_code: String? = nil) {
    self.locality = locality; self.region = region; self.country_code = country_code
  }
}

/// Minimal decode of the server's `Place` object — only what the TV
/// timeline's day-header/caption needs. The wire `place` field is a rich
/// object (`display_name`, `address`, `rollups`, `pois`, lat/lon, etc.);
/// this struct deliberately models only `display_name` and `rollups` and
/// leaves the rest un-modeled. Synthesized `Codable` ignores unknown keys,
/// so the many un-modeled `Place` fields decode without error.
public struct SearchAssetPlace: Codable, Equatable, Sendable {
  public let display_name: String?
  public let rollups: SearchAssetPlaceRollups?

  public init(display_name: String? = nil, rollups: SearchAssetPlaceRollups? = nil) {
    self.display_name = display_name; self.rollups = rollups
  }
}

public struct SearchAsset: Codable, Equatable, Sendable, Identifiable {
  private static let videoExtensions: Set<String> = [
    "mov", "mp4", "m4v", "avi", "mkv", "webm", "mts", "m2ts", "3gp",
    "mxf", "3g2", "flv", "vob", "mpg", "wmv", "f4v",
  ]

  public let id: String
  public let folder_id: String
  public let abs_path: String
  public let filename: String
  public let size: Int64?
  /// Last-modified epoch ms. Wire format is a JSON number — usually an
  /// integer, but the server sometimes sends a fractional value (e.g.
  /// `1776035930475.9543` for a few panorama assets where MongoDB
  /// returned a Decimal128 / Double instead of a NumberLong). Decoding
  /// as Double tolerates both shapes; integer milliseconds round-trip
  /// without loss. Truncate to Int64 if the caller needs that.
  public let mtime: Double?
  public let captured_at: String?
  public let camera: SearchAssetCamera?
  public let lens: String?
  public let iso: Int?
  public let aperture: Double?
  public let shutter: String?
  public let focal_length: Double?
  public let rating: Int?
  /// Pick flag: 1 = pick, 0 = none, -1 = reject. Number on the wire.
  public let flag: Int?
  public let color_label: String?
  public let hidden: Bool?
  /// PhotoKit asset links. Populated by the backup engine when an asset
  /// was ingested via PhotoKit backup. The first entry's `phasset_local_id`
  /// identifies the matching PHAsset so the merged timeline can correlate
  /// cloud rows with local Photos library rows. Optional — nil for assets
  /// that weren't ingested via PhotoKit backup.
  public let phasset_links: [SearchAssetPHLink]?
  /// Whether an XMP sidecar exists for this asset. Optional/absent-tolerant
  /// for backward compat with server responses predating this field (TV
  /// timeline caption's green "edited" dot, #2102).
  public let has_xmp: Bool?
  /// Reverse-geocoded place, when the pipeline has resolved one for this
  /// asset's GPS. `nil` when un-geocoded, no GPS, or (backward compat) the
  /// server response predates this field. Drives the TV timeline
  /// day-section header (#2102).
  public let place: SearchAssetPlace?

  /// Whether this search result names a recognised video container.
  public var isVideo: Bool {
    Self.videoExtensions.contains((filename as NSString).pathExtension.lowercased())
  }

  /// Explicit memberwise init. The synthesized default would require every
  /// caller to pass `phasset_links:` even when nil, which broke existing
  /// tests when PR #53 added the field. Keeping `phasset_links` defaulted
  /// to `nil` here lets pre-PhotoKit-merge test fixtures keep working.
  public init(id: String,
              folder_id: String,
              abs_path: String,
              filename: String,
              size: Int64? = nil,
              mtime: Double? = nil,
              captured_at: String? = nil,
              camera: SearchAssetCamera? = nil,
              lens: String? = nil,
              iso: Int? = nil,
              aperture: Double? = nil,
              shutter: String? = nil,
              focal_length: Double? = nil,
              rating: Int? = nil,
              flag: Int? = nil,
              color_label: String? = nil,
              hidden: Bool? = nil,
              phasset_links: [SearchAssetPHLink]? = nil,
              has_xmp: Bool? = nil,
              place: SearchAssetPlace? = nil) {
    self.id = id
    self.folder_id = folder_id
    self.abs_path = abs_path
    self.filename = filename
    self.size = size
    self.mtime = mtime
    self.captured_at = captured_at
    self.camera = camera
    self.lens = lens
    self.iso = iso
    self.aperture = aperture
    self.shutter = shutter
    self.focal_length = focal_length
    self.rating = rating
    self.flag = flag
    self.color_label = color_label
    self.hidden = hidden
    self.phasset_links = phasset_links
    self.has_xmp = has_xmp
    self.place = place
  }
}

public struct SearchAssetPHLink: Codable, Equatable, Sendable {
  /// `PHAsset.localIdentifier` — per-device key. NOT stable across devices
  /// (each device has its own Photos DB) — keep matching against it for
  /// local-only-library callers, but prefer `phasset_cloud_id` when both
  /// sides have one.
  public let phasset_local_id: String
  /// `PHCloudIdentifier.stringValue` — stable across every device on the
  /// same iCloud Photos account. Optional: nil when the uploading device
  /// didn't have iCloud Photos enabled. Drives the cross-device `.synced`
  /// badge in the merged timeline (see `MergedTimelineSource.merge`).
  public let phasset_cloud_id: String?

  public init(phasset_local_id: String, phasset_cloud_id: String? = nil) {
    self.phasset_local_id = phasset_local_id
    self.phasset_cloud_id = phasset_cloud_id
  }
}

public struct SearchResponse: Codable, Sendable {
  public let total: Int
  public let page: Int
  public let limit: Int
  public let results: [SearchAsset]
  /// Whether this query supports seek pagination (#2129) — true for the
  /// `captured_desc` / `captured_asc` sorts off the relevance-ranked
  /// `placeQuery` path, false everywhere else. Optional so responses from a
  /// server predating the field still decode; readers treat nil as false.
  ///
  /// This is what disambiguates `nextCursor == nil`. With `cursorPaging`
  /// true it means the seek chain is **exhausted** and the caller must stop;
  /// with it false it means seek pagination was never available and the
  /// caller keeps using `page`.
  public let cursorPaging: Bool?
  /// Opaque seek cursor for the next page, or nil when there is none. See
  /// `cursorPaging` for what nil means in each mode.
  public let nextCursor: String?

  /// True when a seek-paginated result set has been walked to its end.
  ///
  /// Callers clamp `total` to the rows they hold when this is true: the
  /// server caches `total` for 30 s and can overstate the set, and trusting
  /// a stale one at the end of the chain leaves the infinite-scroll gate
  /// open — which sends the grid back to deep `page + 1` SKIP paging, the
  /// exact cost cursors exist to remove.
  public var seekExhausted: Bool { cursorPaging == true && nextCursor == nil }

  public init(total: Int,
              page: Int,
              limit: Int,
              results: [SearchAsset],
              cursorPaging: Bool? = nil,
              nextCursor: String? = nil) {
    self.total = total
    self.page = page
    self.limit = limit
    self.results = results
    self.cursorPaging = cursorPaging
    self.nextCursor = nextCursor
  }
}

// MARK: - Facets

// DTOs for /api/search/facets. Mirrors the server's wire format and the
// web `SearchFacets` interface. Decode-only — counts/ranges scoped to the
// current filter set, used to populate the filter sidebar's option lists.

public struct CameraFacet: Codable, Equatable, Sendable {
  public let make: String?
  public let model: String?
  public let count: Int
}

/// Generic `{ value, count }` facet bucket (lenses, extensions, scene
/// types, activities, subjects). `value` is optional because the server
/// emits `null` for assets missing the field (e.g. lens-less captures).
public struct ValueFacet: Codable, Equatable, Sendable {
  public let value: String?
  public let count: Int
}

/// `{ min, max }` numeric range. Decoded as Double so an integer ISO and a
/// fractional aperture both round-trip without a decode failure.
public struct RangeFacet: Codable, Equatable, Sendable {
  public let min: Double
  public let max: Double
}

public struct CaptureRangeFacet: Codable, Equatable, Sendable {
  public let from: String
  public let to: String
}

/// Tri-state screenshot bucket counts. The wire keys are the reserved
/// words `true` / `false`, remapped here via CodingKeys.
public struct ScreenshotFacet: Codable, Equatable, Sendable {
  public let trueCount: Int
  public let falseCount: Int
  public let unknown: Int

  enum CodingKeys: String, CodingKey {
    case trueCount = "true"
    case falseCount = "false"
    case unknown
  }
}

public struct SearchFacets: Codable, Sendable {
  public let total: Int
  public let cameras: [CameraFacet]
  public let lenses: [ValueFacet]
  public let extensions: [ValueFacet]
  public let iso_range: RangeFacet?
  public let capture_range: CaptureRangeFacet?
  public let scene_types: [ValueFacet]
  public let activities: [ValueFacet]
  public let subjects: [ValueFacet]
  public let is_screenshot: ScreenshotFacet
}
