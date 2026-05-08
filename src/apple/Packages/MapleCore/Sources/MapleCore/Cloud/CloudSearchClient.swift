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

  /// `GET /api/search/buckets?libraryId=<id>` — single call, returns all
  /// year/month aggregations for a library plus the count of un-timed assets.
  public func buckets(libraryID: String) async throws -> TimelineBuckets {
    let url = makeURL(path: "/api/search/buckets",
                      query: [URLQueryItem(name: "libraryId", value: libraryID)])
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

  /// `GET /api/search?libraryId=<id>&from=YYYY-MM-01&to=YYYY-MM-LAST&page=N&limit=N&sort=...`
  /// One page of assets in the given year/month bucket. Defaults match the
  /// web Timeline (200 / page, captured_desc).
  ///
  /// `page` is **zero-indexed** to match the server contract — the web
  /// Timeline starts paginating at page 0. Sending page=1 first skips the
  /// first `limit` results, which silently returns empty for any bucket
  /// whose count is ≤ `limit` (e.g. a month with 15 photos returns
  /// `total: 15, results: []` for page 1).
  public func page(libraryID: String,
                   year: Int,
                   month: Int,
                   page: Int = 0,
                   limit: Int = 200,
                   sort: String = "captured_desc") async throws -> SearchResponse {
    let from = String(format: "%04d-%02d-01", year, month)
    let to = Self.lastDay(year: year, month: month)
    // hasCapturedAt=true keeps the result set aligned with what
    // /api/search/buckets counts. The buckets agg implicitly filters on
    // captured_at (it groups by year/month from that field), so without
    // this flag the search count and the bucket count can disagree —
    // the web Timeline always sends it for the same reason.
    let items: [URLQueryItem] = [
      URLQueryItem(name: "libraryId", value: libraryID),
      URLQueryItem(name: "from", value: from),
      URLQueryItem(name: "to", value: to),
      URLQueryItem(name: "page", value: "\(page)"),
      URLQueryItem(name: "limit", value: "\(limit)"),
      URLQueryItem(name: "sort", value: sort),
      URLQueryItem(name: "hasCapturedAt", value: "true"),
    ]
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
