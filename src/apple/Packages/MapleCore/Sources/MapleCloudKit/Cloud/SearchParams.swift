// SearchParams.swift
//
// Swift mirror of the web app's `SearchParams` wire contract
// (src/web/projects/maple-common/src/lib/api/search.service.ts). Every
// field maps 1:1 to a `GET /api/search` / `/api/search/facets` query
// parameter; `listQueryItems` / `facetQueryItems` serialise exactly the
// values the user set, skipping nil / empty entries — matching the web
// `paramsFrom()` helper so the Apple search hits the same server contract
// the web UI does.

import Foundation

// MARK: - Enums

/// Result ordering. Raw values are the server's `sort` tokens.
public enum SearchSort: String, Codable, Sendable, CaseIterable {
  case capturedDesc = "captured_desc"
  case capturedAsc = "captured_asc"
  case name
  case rating

  /// Human-readable label — mirrors the web `SORT_LABEL` table.
  public var label: String {
    switch self {
    case .capturedDesc: return "Newest first"
    case .capturedAsc: return "Oldest first"
    case .name: return "Name"
    case .rating: return "Rating"
    }
  }
}

/// Pick flag filter. Raw values are the server tokens.
public enum SearchFlag: String, Codable, Sendable, CaseIterable {
  case pick
  case reject
  case none

  public var label: String {
    switch self {
    case .pick: return "Pick"
    case .reject: return "Reject"
    case .none: return "None"
    }
  }
}

/// Color-label filter. Raw values are the server tokens; the hex swatches
/// mirror the web `COLOR_LABELS` table.
public enum SearchColor: String, Codable, Sendable, CaseIterable {
  case red
  case yellow
  case green
  case blue
  case purple

  public var label: String { rawValue.capitalized }

  /// Swatch hex — matches the web `COLOR_LABELS` swatches.
  public var swatchHex: String {
    switch self {
    case .red: return "#e11d48"
    case .yellow: return "#eab308"
    case .green: return "#22c55e"
    case .blue: return "#3b82f6"
    case .purple: return "#a855f7"
    }
  }
}

/// Vision scene-type filter (closed union). Raw values are server tokens.
public enum SearchSceneType: String, Codable, Sendable, CaseIterable {
  case indoor
  case outdoor
  case aerial
  case macro
  case studio
  case mixed

  public var label: String { rawValue.capitalized }
}

/// Hidden filter options.
public enum SearchHidden: String, Codable, Sendable, CaseIterable {
  case none = "none"
  case only = "only"
  case all  = "all"

  public var label: String {
    switch self {
    case .none: return "Exclude"
    case .only: return "Only"
    case .all:  return "Include"
    }
  }
}

// MARK: - SearchParams

/// All `GET /api/search` query parameters. Mirrors the web `SearchParams`
/// interface field-for-field. Optional fields are omitted from the query
/// string when nil / empty.
public struct SearchParams: Sendable, Equatable, Hashable {
  /// Filename/path substring match (case-insensitive on
  /// `fileinfo.filename` / `fileinfo.path`). Not driven by the main search
  /// box — kept for the server contract / future filename-scoped search.
  public var q: String = ""
  /// Free-text content search against the unified `search_blob` (place +
  /// caption + OCR + people). Natural-language dates and person names work
  /// with or without Meilisearch; when Meilisearch is configured it adds
  /// typo-tolerance and semantic ranking on top. This is what the main
  /// search box drives — mirrors the web `placeQuery`.
  public var placeQuery: String = ""
  /// Scope to one registered library (folder ObjectId hex).
  public var libraryID: String?
  /// Case-insensitive substring on camera make / model.
  public var camera: String?
  /// Case-insensitive substring on lens.
  public var lens: String?
  public var isoMin: Int?
  public var isoMax: Int?
  public var apertureMin: Double?
  public var apertureMax: Double?
  public var focalMin: Double?
  public var focalMax: Double?
  /// `captured_at >=` — bare `YYYY-MM-DD` is widened server-side.
  public var from: String?
  /// `captured_at <=` — bare `YYYY-MM-DD` is widened server-side.
  public var to: String?
  /// Minimum star rating (`>= n`).
  public var rating: Int?
  public var flag: SearchFlag?
  public var color: SearchColor?
  /// Extension list, e.g. `["dng", "cr3"]`. Sent as a comma-joined `ext`.
  public var ext: [String] = []
  public var sceneType: SearchSceneType?
  /// Vision activity (open vocab, exact match).
  public var activity: String?
  /// UI scope chip (S7): `places` / `people` / `albums`. nil / empty = the
  /// full live set (the server treats absent and `photos` identically). Raw
  /// server tokens — see `SEARCH_SCOPES` in src/api/src/routes/search/query.ts.
  public var scope: String?
  /// Subject tags. Sent comma-joined; the server OR's within the field.
  public var subjects: [String] = []
  /// Tri-state screenshot filter: true → screenshots only, false →
  /// photographs only, nil → both.
  public var isScreenshot: Bool?
  /// Anchored prefix on `abs_path` (server applies as `^prefix`).
  public var pathPrefix: String?
  /// When true, only assets with a non-null `captured_at` match.
  public var hasCapturedAt: Bool?
  public var hidden: SearchHidden = .none
  /// Drop assets showing a soft-hidden person. Opt-in: `nil` (the default)
  /// keeps the server's historical behaviour, where hiding a person only
  /// removes them from the People listing and their photos still surface in
  /// search. Set by ambient surfaces that display photos unattended (the TV
  /// Light Table) so someone deliberately hidden can't reappear on screen.
  /// Hidden *images* need no flag — the server excludes those by default.
  public var excludeHiddenPeople: Bool?
  public var sort: SearchSort = .capturedDesc

  public init(libraryID: String? = nil) {
    self.libraryID = libraryID
  }

  /// True when any structured filter (anything besides q / sort /
  /// libraryID / pathPrefix) is set. Drives the "filters active" dot.
  public var hasActiveFilters: Bool {
    camera != nil || lens != nil
      || isoMin != nil || isoMax != nil
      || apertureMin != nil || apertureMax != nil
      || focalMin != nil || focalMax != nil
      || from != nil || to != nil
      || rating != nil || flag != nil || color != nil
      || !ext.isEmpty || sceneType != nil || activity != nil
      || !subjects.isEmpty || isScreenshot != nil || hasCapturedAt != nil
      || hidden != .none
  }

  // MARK: - Serialisation

  /// Query items for `/api/search/facets` — everything except page / limit
  /// / sort (the server ignores those for facet aggregation).
  public func facetQueryItems() -> [URLQueryItem] {
    baseItems()
  }

  /// Query items for `/api/search` — base filters plus sort + pagination.
  public func listQueryItems(page: Int, limit: Int) -> [URLQueryItem] {
    var items = baseItems()
    items.append(URLQueryItem(name: "sort", value: sort.rawValue))
    items.append(URLQueryItem(name: "page", value: "\(page)"))
    items.append(URLQueryItem(name: "limit", value: "\(limit)"))
    return items
  }

  /// Shared filter serialisation. Mirrors the web `paramsFrom()` skip
  /// rules: nil values and empty strings/arrays are omitted entirely.
  private func baseItems() -> [URLQueryItem] {
    var items: [URLQueryItem] = []
    func add(_ name: String, _ value: String?) {
      guard let value, !value.isEmpty else { return }
      items.append(URLQueryItem(name: name, value: value))
    }

    add("q", q)
    add("placeQuery", placeQuery)
    add("libraryId", libraryID)
    add("camera", camera)
    add("lens", lens)
    add("isoMin", isoMin.map(String.init))
    add("isoMax", isoMax.map(String.init))
    add("apertureMin", apertureMin.map { Self.format($0) })
    add("apertureMax", apertureMax.map { Self.format($0) })
    add("focalMin", focalMin.map { Self.format($0) })
    add("focalMax", focalMax.map { Self.format($0) })
    add("from", from)
    add("to", to)
    add("rating", rating.map(String.init))
    add("flag", flag?.rawValue)
    add("color", color?.rawValue)
    if !ext.isEmpty { add("ext", ext.joined(separator: ",")) }
    add("pathPrefix", pathPrefix)
    if let hasCapturedAt { add("hasCapturedAt", hasCapturedAt ? "true" : "false") }
    if excludeHiddenPeople == true { add("excludeHiddenPeople", "true") }
    add("sceneType", sceneType?.rawValue)
    add("activity", activity)
    add("scope", scope)
    if hidden != .none { add("hidden", hidden.rawValue) }
    if !subjects.isEmpty { add("subjects", subjects.joined(separator: ",")) }
    if let isScreenshot { add("isScreenshot", isScreenshot ? "true" : "false") }
    return items
  }

  /// Format a Double without a trailing `.0` for whole numbers (so a
  /// focal length of 50 serialises as `50`, not `50.0`). Matches what a
  /// user would type and what the server's numeric parse expects.
  private static func format(_ value: Double) -> String {
    if value == value.rounded() && abs(value) < 1e15 {
      return String(Int(value))
    }
    return String(value)
  }
}
