// CloudSearchClient.swift
//
// Typed wrappers for `/api/search/buckets` (year/month aggregation) and
// `/api/search` (paginated assets per month). The Apple Timeline view
// drives both endpoints — buckets once on library open, search per month
// as cells scroll into view.

import Foundation

public actor CloudSearchClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  /// Sample client for SwiftUI `#Preview` blocks. Points at an unreachable
  /// example server; any /api/search call fails fast, leaving the timeline
  /// rendering its empty/loading state. Issue #139.
  public static func preview(
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> CloudSearchClient {
    CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.preview(server: server)
    )
  }

  /// `GET /api/search/buckets?libraryId=<id>[&pathPrefix=<p>]` — returns
  /// year/month aggregations for the given library, optionally narrowed
  /// to a sub-folder. `pathPrefix` must be RELATIVE to the library root
  /// (e.g. `2026/spain`, not the absolute on-disk path): since the
  /// drop-abs-path migration the server anchors it against `fileinfo.path`,
  /// which stores each asset's directory relative to its library root.
  /// `libraryId` scopes to the library; `pathPrefix` narrows within it.
  /// Sending the same pathPrefix to `page()` keeps buckets and page result
  /// sets in agreement. Build it with `relativePathPrefix(absPath:libraryRoot:)`.
  public func buckets(libraryID: String,
                      pathPrefix: String? = nil) async throws -> TimelineBuckets {
    var items: [URLQueryItem] = [URLQueryItem(name: "libraryId", value: libraryID)]
    if let p = Self.normalizePathPrefix(pathPrefix) {
      items.append(URLQueryItem(name: "pathPrefix", value: p))
    }
    let url = makeURL(path: "/api/search/buckets", query: items)
    let (data, resp) = try await httpClient.data(for: URLRequest(url: url))
    try Self.checkOK(resp, data: data)
    do {
      return try JSONDecoder().decode(TimelineBuckets.self, from: data)
    } catch {
      let preview = String(data: data.prefix(2048), encoding: .utf8) ?? "<non-utf8 \(data.count)B>"
      cloudHTTPLogger.error("decode TimelineBuckets failed (library \(libraryID, privacy: .public)): \(error.localizedDescription, privacy: .public) — body preview: \(preview, privacy: .public)")
      throw error
    }
  }

  /// `GET /api/search?libraryId=<id>&from=YYYY-MM-01&to=YYYY-MM-LAST&page=N&limit=N&sort=...[&pathPrefix=<p>]`
  /// One page of assets in the given year/month bucket. Defaults match the
  /// web Timeline (200 / page, captured_desc).
  ///
  /// `page` is **zero-indexed** to match the server contract — the web
  /// Timeline starts paginating at page 0. Sending page=1 first skips the
  /// first `limit` results, which silently returns empty for any bucket
  /// whose count is ≤ `limit` (e.g. a month with 15 photos returns
  /// `total: 15, results: []` for page 1).
  ///
  /// `pathPrefix`, if non-nil, narrows results to a sub-folder and is
  /// RELATIVE to the library root (the server anchors it against
  /// `fileinfo.path`). Sending it on `page()` AND `buckets()` for the same
  /// scope keeps counts and listings in agreement.
  public func page(libraryID: String,
                   year: Int,
                   month: Int,
                   page: Int = 0,
                   limit: Int = 200,
                   sort: String = "captured_desc",
                   pathPrefix: String? = nil) async throws -> SearchResponse {
    let from = String(format: "%04d-%02d-01", year, month)
    let to = Self.lastDay(year: year, month: month)
    // hasCapturedAt=true keeps the result set aligned with what
    // /api/search/buckets counts. The buckets agg implicitly filters on
    // captured_at (it groups by year/month from that field), so without
    // this flag the search count and the bucket count can disagree —
    // the web Timeline always sends it for the same reason.
    var items: [URLQueryItem] = [
      URLQueryItem(name: "libraryId", value: libraryID),
      URLQueryItem(name: "from", value: from),
      URLQueryItem(name: "to", value: to),
      URLQueryItem(name: "page", value: "\(page)"),
      URLQueryItem(name: "limit", value: "\(limit)"),
      URLQueryItem(name: "sort", value: sort),
      URLQueryItem(name: "hasCapturedAt", value: "true"),
    ]
    if let p = Self.normalizePathPrefix(pathPrefix) {
      items.append(URLQueryItem(name: "pathPrefix", value: p))
    }
    let url = makeURL(path: "/api/search", query: items)
    let (data, resp) = try await httpClient.data(for: URLRequest(url: url))
    try Self.checkOK(resp, data: data)
    do {
      return try JSONDecoder().decode(SearchResponse.self, from: data)
    } catch {
      let preview = String(data: data.prefix(2048), encoding: .utf8) ?? "<non-utf8 \(data.count)B>"
      cloudHTTPLogger.error("decode SearchResponse failed (library \(libraryID, privacy: .public), \(year, privacy: .public)-\(month, privacy: .public)): \(error.localizedDescription, privacy: .public) — body preview: \(preview, privacy: .public)")
      throw error
    }
  }

  /// `GET /api/search?...` — full structured search. Serialises every
  /// filter the user set (mirrors the web `SearchService.search`) plus
  /// sort + pagination. `page` is zero-indexed to match the server.
  ///
  /// Pass `cursor` (from a previous response's `nextCursor`) to seek
  /// instead of skipping — see `SearchParams.listQueryItems`. `page` is
  /// ignored when a cursor is supplied.
  public func search(_ params: SearchParams,
                     page: Int,
                     limit: Int,
                     cursor: String? = nil) async throws -> SearchResponse {
    let url = makeURL(path: "/api/search",
                      query: params.listQueryItems(page: page, limit: limit, cursor: cursor))
    let (data, resp) = try await httpClient.data(for: URLRequest(url: url))
    try Self.checkOK(resp, data: data)
    do {
      return try JSONDecoder().decode(SearchResponse.self, from: data)
    } catch {
      let preview = String(data: data.prefix(2048), encoding: .utf8) ?? "<non-utf8 \(data.count)B>"
      cloudHTTPLogger.error("decode SearchResponse (search) failed: \(error.localizedDescription, privacy: .public) — body preview: \(preview, privacy: .public)")
      throw error
    }
  }

  /// `GET /api/search/facets?...` — counts/ranges scoped to the same
  /// filter set (page/limit/sort omitted). Drives the filter panel's
  /// option lists.
  public func facets(_ params: SearchParams) async throws -> SearchFacets {
    let url = makeURL(path: "/api/search/facets", query: params.facetQueryItems())
    let (data, resp) = try await httpClient.data(for: URLRequest(url: url))
    try Self.checkOK(resp, data: data)
    do {
      return try JSONDecoder().decode(SearchFacets.self, from: data)
    } catch {
      let preview = String(data: data.prefix(2048), encoding: .utf8) ?? "<non-utf8 \(data.count)B>"
      cloudHTTPLogger.error("decode SearchFacets failed: \(error.localizedDescription, privacy: .public) — body preview: \(preview, privacy: .public)")
      throw error
    }
  }

  // MARK: - Helpers

  /// Trim whitespace, drop empty, and append a trailing slash so the
  /// server's anchored-prefix match doesn't span partial directory
  /// names (e.g. `2026` would otherwise also match `2026-archive`).
  /// Returns nil when the input is nil or empty after trim — callers
  /// omit the query param in that case.
  private static func normalizePathPrefix(_ raw: String?) -> String? {
    guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
          !raw.isEmpty else { return nil }
    return raw.hasSuffix("/") ? raw : raw + "/"
  }

  /// Convert a selected node's ABSOLUTE on-disk path into a path RELATIVE
  /// to its owning library root — the shape `buckets`/`page` expect for
  /// `pathPrefix`. Since the drop-abs-path migration the server matches
  /// `pathPrefix` against `fileinfo.path` (the per-asset directory relative
  /// to the library root), so sending the absolute path matched zero rows
  /// and left the Timeline empty.
  ///
  /// Returns nil — meaning "no sub-folder narrowing, scope by libraryId
  /// alone" — when:
  ///   * the selection IS the library root (whole library in scope), or
  ///   * `libraryRoot` is nil / doesn't contain `absPath` (can't resolve a
  ///     relative path; a library-wide scope is the safe fallback, never
  ///     an absolute prefix that matches nothing).
  public static func relativePathPrefix(absPath: String, libraryRoot: String?) -> String? {
    guard let libraryRoot else { return nil }
    let root = libraryRoot.hasSuffix("/") ? String(libraryRoot.dropLast()) : libraryRoot
    let abs = absPath.hasSuffix("/") ? String(absPath.dropLast()) : absPath
    if abs == root { return nil }
    let boundary = root + "/"
    guard abs.hasPrefix(boundary) else { return nil }
    let rel = String(abs.dropFirst(boundary.count))
    return rel.isEmpty ? nil : rel
  }

  private func makeURL(path: String, query: [URLQueryItem]) -> URL {
    var c = URLComponents(url: server.appending(path: path), resolvingAgainstBaseURL: false)!
    c.queryItems = query
    return c.url!
  }

  private static func lastDay(year: Int, month: Int) -> String {
    var c = DateComponents(); c.year = year; c.month = month
    let cal = Calendar(identifier: .gregorian)
    guard let d = cal.date(from: c),
          let range = cal.range(of: .day, in: .month, for: d) else {
      return String(format: "%04d-%02d-28", year, month)
    }
    let last = range.upperBound - 1
    return String(format: "%04d-%02d-%02d", year, month, last)
  }

  private static func checkOK(_ resp: URLResponse, data: Data) throws {
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw NSError(domain: "CloudSearchClient",
                    code: (resp as? HTTPURLResponse)?.statusCode ?? -1,
                    userInfo: [NSLocalizedDescriptionKey: body])
    }
  }
}
