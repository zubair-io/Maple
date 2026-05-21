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
  /// to records whose `abs_path` starts with `pathPrefix`. Sending the
  /// same pathPrefix to `page()` keeps buckets and page result sets in
  /// agreement.
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
  /// `pathPrefix`, if non-nil, scopes results to assets whose `abs_path`
  /// starts with that prefix. The server applies it as an anchored
  /// prefix on `abs_path` — sending it on `page()` AND `buckets()` for
  /// the same scope keeps counts and listings in agreement.
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

  // MARK: - Helpers

  /// Trim whitespace, drop empty, and append a trailing slash so the
  /// server's anchored-prefix match doesn't span partial directory
  /// names (e.g. `/srv/photos/Library` would otherwise also match
  /// `/srv/photos/Library2024`). Returns nil when the input is nil or
  /// empty after trim — callers omit the query param in that case.
  private static func normalizePathPrefix(_ raw: String?) -> String? {
    guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
          !raw.isEmpty else { return nil }
    return raw.hasSuffix("/") ? raw : raw + "/"
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
