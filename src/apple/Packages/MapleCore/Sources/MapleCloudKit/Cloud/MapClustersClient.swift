// MapClustersClient.swift
//
// Wraps `GET /api/map/clusters` (#2825/#2832) — grid-bucket aggregation
// over every asset with a GPS position inside the requested viewport,
// filtered by whatever search filter (`SearchParams`) the caller has
// active. One endpoint drives every Apple map surface: the clustered
// pins here (#2830), the tvOS map (#2833), and both heatmap overlays
// (#2831/#2834).

import Foundation

public actor MapClustersClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  /// `GET /api/map/clusters?bbox=w,s,e,n&zoom=N&<filter>`. `filter`'s
  /// serialisation reuses `SearchParams.facetQueryItems()` — the base
  /// filter items `/api/search/facets` sends (no `sort`/paging, which the
  /// map endpoint doesn't take either).
  public func clusters(bbox: MapBBox, zoom: Int, filter: SearchParams) async throws -> MapClustersResponse {
    var items = filter.facetQueryItems()
    items.append(URLQueryItem(name: "bbox", value: bbox.queryValue))
    items.append(URLQueryItem(name: "zoom", value: "\(zoom)"))
    let url = makeURL(path: "/api/map/clusters", query: items)
    let (data, resp) = try await httpClient.data(for: URLRequest(url: url))
    try Self.checkOK(resp, data: data)
    do {
      return try JSONDecoder().decode(MapClustersResponse.self, from: data)
    } catch {
      let preview = String(data: data.prefix(2048), encoding: .utf8) ?? "<non-utf8 \(data.count)B>"
      cloudHTTPLogger.error("decode MapClustersResponse failed: \(error.localizedDescription, privacy: .public) — body preview: \(preview, privacy: .public)")
      throw error
    }
  }

  /// Sample client for SwiftUI `#Preview` blocks. Points at an unreachable
  /// example server; any request fails fast, leaving the map rendering
  /// its empty/loading state.
  public static func preview(
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> MapClustersClient {
    MapClustersClient(server: server, httpClient: AuthenticatedHTTPClient.preview(server: server))
  }

  private func makeURL(path: String, query: [URLQueryItem]) -> URL {
    var c = URLComponents(url: server.appending(path: path), resolvingAgainstBaseURL: false)!
    c.queryItems = query
    return c.url!
  }

  private static func checkOK(_ resp: URLResponse, data: Data) throws {
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw NSError(domain: "MapClustersClient",
                    code: (resp as? HTTPURLResponse)?.statusCode ?? -1,
                    userInfo: [NSLocalizedDescriptionKey: body])
    }
  }
}
