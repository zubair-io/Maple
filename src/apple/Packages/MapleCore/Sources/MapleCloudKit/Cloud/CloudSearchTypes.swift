// CloudSearchTypes.swift
//
// DTOs for /api/search/buckets and /api/search. Mirrors the server's wire
// format from src/api/src/routes/search.ts. Keep field names exactly as
// the server emits them — these are decoded from raw JSON.
// Wire-named fields use scoped naming exemptions, matching AuthUser.file_access.

import Foundation

public struct TimelineBucket: Codable, Equatable, Sendable {
  public let year: Int
  public let month: Int
  public let count: Int

  public init(year: Int, month: Int, count: Int) {
    self.year = year
    self.month = month
    self.count = count
  }
}

public struct TimelineBuckets: Codable, Sendable {
  public let total: Int
  public let buckets: [TimelineBucket]
  // swift-format-ignore: AlwaysUseLowerCamelCase
  public let untimed_count: Int

  public init(total: Int, buckets: [TimelineBucket], untimed_count: Int) {
    self.total = total
    self.buckets = buckets
    self.untimed_count = untimed_count
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
  // swift-format-ignore: AlwaysUseLowerCamelCase
  public let country_code: String?

  public init(locality: String? = nil, region: String? = nil, country_code: String? = nil) {
    self.locality = locality
    self.region = region
    self.country_code = country_code
  }
}

/// Minimal decode of the server's `Place` object — only what the TV
/// timeline's day-header/caption needs. The wire `place` field is a rich
/// object (`display_name`, `address`, `rollups`, `pois`, lat/lon, etc.);
/// this struct deliberately models only `display_name` and `rollups` and
/// leaves the rest un-modeled. Synthesized `Codable` ignores unknown keys,
/// so the many un-modeled `Place` fields decode without error.
public struct SearchAssetPlace: Codable, Equatable, Sendable {
  // swift-format-ignore: AlwaysUseLowerCamelCase
  public let display_name: String?
  public let rollups: SearchAssetPlaceRollups?

  public init(display_name: String? = nil, rollups: SearchAssetPlaceRollups? = nil) {
    self.display_name = display_name
    self.rollups = rollups
  }
}

/// Actual server attribution; email can be absent for device-only users.
public struct CloudAssetOwner: Codable, Equatable, Sendable {
  public let id: String
  public let email: String?

  public init(id: String, email: String?) {
    self.id = id
    self.email = email
  }
}

/// Owners without an account email still participate in library facets.
public struct AssetOwnerFacet: Codable, Equatable, Sendable, Identifiable {
  public let id: String
  public let email: String?
  public let count: Int

  public init(id: String, email: String?, count: Int) {
    self.id = id
    self.email = email
    self.count = count
  }
}

public struct SearchAsset: Codable, Equatable, Sendable, Identifiable {
  private static let videoExtensions: Set<String> = [
    "mov", "mp4", "m4v", "avi", "mkv", "webm", "mts", "m2ts", "3gp",
    "mxf", "3g2", "flv", "vob", "mpg", "wmv", "f4v",
  ]

  public let id: String
  // swift-format-ignore: AlwaysUseLowerCamelCase
  public let folder_id: String
  // swift-format-ignore: AlwaysUseLowerCamelCase
  public let abs_path: String
  /// `slug:relPath` unified address (`src/api/src/routes/search/project.ts`
  /// emits it as `address`). Optional/absent-tolerant: `null` when the asset
  /// has no slug mapping, and absent from responses predating unified
  /// addressing. Threaded into `AssetRef.catalog` so the info pane can fetch
  /// the rich detail via `GET /api/assets/by-address` (#2518).
  public let address: String?
  public let filename: String
  public let size: Int64?
  /// Last-modified epoch ms. Wire format is a JSON number — usually an
  /// integer, but the server sometimes sends a fractional value (e.g.
  /// `1776035930475.9543` for a few panorama assets where MongoDB
  /// returned a Decimal128 / Double instead of a NumberLong). Decoding
  /// as Double tolerates both shapes; integer milliseconds round-trip
  /// without loss. Truncate to Int64 if the caller needs that.
  public let mtime: Double?
  // swift-format-ignore: AlwaysUseLowerCamelCase
  public let captured_at: String?
  public let camera: SearchAssetCamera?
  public let lens: String?
  public let iso: Int?
  public let aperture: Double?
  public let shutter: String?
  // swift-format-ignore: AlwaysUseLowerCamelCase
  public let focal_length: Double?
  public let rating: Int?
  /// Pick flag: 1 = pick, 0 = none, -1 = reject. Number on the wire.
  public let flag: Int?
  // swift-format-ignore: AlwaysUseLowerCamelCase
  public let color_label: String?
  public let hidden: Bool?
  // swift-format-ignore: AlwaysUseLowerCamelCase
  public let owner_id: String?
  public let owner: CloudAssetOwner?
  /// PhotoKit asset links. Populated by the backup engine when an asset
  /// was ingested via PhotoKit backup. The first entry's `phasset_local_id`
  /// identifies the matching PHAsset so the merged timeline can correlate
  /// cloud rows with local Photos library rows. Optional — nil for assets
  /// that weren't ingested via PhotoKit backup.
  // swift-format-ignore: AlwaysUseLowerCamelCase
  public let phasset_links: [SearchAssetPHLink]?
  /// Whether an XMP sidecar exists for this asset. Optional/absent-tolerant
  /// for backward compat with server responses predating this field (TV
  /// timeline caption's green "edited" dot, #2102).
  // swift-format-ignore: AlwaysUseLowerCamelCase
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
  public init(
    id: String,
    folder_id: String,
    abs_path: String,
    address: String? = nil,
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
    place: SearchAssetPlace? = nil,
    owner_id: String? = nil,
    owner: CloudAssetOwner? = nil
  ) {
    self.id = id
    self.folder_id = folder_id
    self.abs_path = abs_path
    self.address = address
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
    self.owner_id = owner_id
    self.owner = owner
  }
}

public struct SearchAssetPHLink: Codable, Equatable, Sendable {
  /// `PHAsset.localIdentifier` — per-device key. NOT stable across devices
  /// (each device has its own Photos DB) — keep matching against it for
  /// local-only-library callers, but prefer `phasset_cloud_id` when both
  /// sides have one.
  // swift-format-ignore: AlwaysUseLowerCamelCase
  public let phasset_local_id: String
  /// `PHCloudIdentifier.stringValue` — stable across every device on the
  /// same iCloud Photos account. Optional: nil when the uploading device
  /// didn't have iCloud Photos enabled. Drives the cross-device `.synced`
  /// badge in the merged timeline (see `MergedTimelineSource.merge`).
  // swift-format-ignore: AlwaysUseLowerCamelCase
  public let phasset_cloud_id: String?

  public init(phasset_local_id: String, phasset_cloud_id: String? = nil) {
    self.phasset_local_id = phasset_local_id
    self.phasset_cloud_id = phasset_cloud_id
  }
}

/// The capture-date window the server actually applied.
///
/// `inferredFrom` carries the search text the window was derived from, and is
/// present only when the server read it out of the query rather than taking an
/// explicit `from`/`to`. That is the case the UI has to attribute: the user
/// never chose it and nothing in the filter panel reflects it, which is how a
/// search could be silently clamped to three months while the panel showed no
/// date at all (#2956).
public struct AppliedDateFilter: Codable, Sendable, Equatable {
  public let from: String?
  public let to: String?
  public let inferredFrom: String?

  public init(from: String? = nil, to: String? = nil, inferredFrom: String? = nil) {
    self.from = from
    self.to = to
    self.inferredFrom = inferredFrom
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
  /// The capture-date window in effect, when there is one. Optional so
  /// responses from a server predating the field still decode.
  public let dateFilter: AppliedDateFilter?

  /// True when a seek-paginated result set has been walked to its end.
  ///
  /// Callers clamp `total` to the rows they hold when this is true: the
  /// server caches `total` for 30 s and can overstate the set, and trusting
  /// a stale one at the end of the chain leaves the infinite-scroll gate
  /// open — which sends the grid back to deep `page + 1` SKIP paging, the
  /// exact cost cursors exist to remove.
  public var seekExhausted: Bool { cursorPaging == true && nextCursor == nil }

  public init(
    total: Int,
    page: Int,
    limit: Int,
    results: [SearchAsset],
    cursorPaging: Bool? = nil,
    nextCursor: String? = nil,
    dateFilter: AppliedDateFilter? = nil
  ) {
    self.total = total
    self.page = page
    self.limit = limit
    self.results = results
    self.cursorPaging = cursorPaging
    self.nextCursor = nextCursor
    self.dateFilter = dateFilter
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

  public init(value: String?, count: Int) {
    self.value = value
    self.count = count
  }
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

/// Which matches the facet counts describe (#4431). `.all` — every match.
/// `.top` — a broad text search's `limit` most relevant results of `of`
/// matches, so a person or place found only among weaker matches has no
/// bucket. Servers predating the field, and any `kind` this client doesn't
/// know, decode as `.all`.
public enum FacetScope: Codable, Sendable, Equatable {
  case all
  case top(limit: Int, of: Int)

  private enum CodingKeys: String, CodingKey { case kind, limit, of }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    guard
      try c.decodeIfPresent(String.self, forKey: .kind) == "top",
      let limit = try c.decodeIfPresent(Int.self, forKey: .limit),
      let of = try c.decodeIfPresent(Int.self, forKey: .of)
    else {
      self = .all
      return
    }
    self = .top(limit: limit, of: of)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .all:
      try c.encode("all", forKey: .kind)
    case .top(let limit, let of):
      try c.encode("top", forKey: .kind)
      try c.encode(limit, forKey: .limit)
      try c.encode(of, forKey: .of)
    }
  }

  /// The line a filter surface shows when the counts are cut, else nil.
  public var note: String? {
    guard case .top(let limit, let of) = self else { return nil }
    return "Filters from the \(limit.formatted()) most relevant of \(of.formatted()) results"
  }
}

public struct SearchFacets: Codable, Sendable {
  public let total: Int
  public let cameras: [CameraFacet]
  public let lenses: [ValueFacet]
  public let extensions: [ValueFacet]
  // swift-format-ignore: AlwaysUseLowerCamelCase
  public let iso_range: RangeFacet?
  // swift-format-ignore: AlwaysUseLowerCamelCase
  public let capture_range: CaptureRangeFacet?
  // swift-format-ignore: AlwaysUseLowerCamelCase
  public let scene_types: [ValueFacet]
  public let activities: [ValueFacet]
  public let subjects: [ValueFacet]
  // swift-format-ignore: AlwaysUseLowerCamelCase
  public let is_screenshot: ScreenshotFacet
  /// Named, non-hidden persons with filter-aware counts, descending
  /// (#2866). `value` round-trips into `SearchParams.people`. Decoded
  /// tolerant — absent on servers predating the field → empty.
  public let people: [ValueFacet]
  /// Place labels with filter-aware counts, descending (#2866). `value`
  /// round-trips into `SearchParams.place`. Absent → empty, as above.
  public let places: [ValueFacet]
  /// Absent on older servers; their existing search filters still decode.
  public let owners: [AssetOwnerFacet]
  /// Which matches the buckets above count. See ``FacetScope``.
  public let scope: FacetScope

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    total = try c.decode(Int.self, forKey: .total)
    cameras = try c.decode([CameraFacet].self, forKey: .cameras)
    lenses = try c.decode([ValueFacet].self, forKey: .lenses)
    extensions = try c.decode([ValueFacet].self, forKey: .extensions)
    iso_range = try c.decodeIfPresent(RangeFacet.self, forKey: .iso_range)
    capture_range = try c.decodeIfPresent(CaptureRangeFacet.self, forKey: .capture_range)
    scene_types = try c.decode([ValueFacet].self, forKey: .scene_types)
    activities = try c.decode([ValueFacet].self, forKey: .activities)
    subjects = try c.decode([ValueFacet].self, forKey: .subjects)
    is_screenshot = try c.decode(ScreenshotFacet.self, forKey: .is_screenshot)
    people = try c.decodeIfPresent([ValueFacet].self, forKey: .people) ?? []
    places = try c.decodeIfPresent([ValueFacet].self, forKey: .places) ?? []
    owners = try c.decodeIfPresent([AssetOwnerFacet].self, forKey: .owners) ?? []
    // A malformed scope must not cost the whole facet response its filters.
    scope = (try? c.decodeIfPresent(FacetScope.self, forKey: .scope)) ?? .all
  }
}
