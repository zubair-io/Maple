// GeneratedSearchClient.swift
//
// Typed wrapper for `/api/generated-searches` — the daily themed collections
// the server's generated-search worker invents ("Spooky Nights", "Seven
// Summers of Lake George").
//
// Two endpoints, and the split matters: the list call returns cards (title,
// subtitle, cover, count) cheaply enough for a widget refresh, while the
// assets call re-runs the stored query server-side. Nothing here reconstructs
// a query from the card — the server forces `excludeHiddenPeople` and the
// screenshot exclusion when it executes, so a client that built its own
// search from `card.query` would quietly lose those guarantees.

import Foundation

/// One collection card.
///
/// `query` is the stored search as raw string pairs — modelled for LINK
/// construction only (the widget's `maple://search?…` tap opens the app's
/// search UI seeded with it, an attended surface). Executing it from a
/// widget for DISPLAY is still wrong: the server applies the hidden-people
/// and screenshot exclusions when it runs the stored query, so ambient
/// rendering must keep going through `assets(collectionID:)`.
public struct GeneratedSearchCard: Codable, Equatable, Sendable, Identifiable {
  public let id: String
  public let theme: String
  public let title: String
  public let subtitle: String?
  public let query: [String: String]
  public let result_count: Int
  public let cover_asset_id: String?
  public let generated_for: String

  public init(
    id: String,
    theme: String,
    title: String,
    subtitle: String? = nil,
    query: [String: String] = [:],
    result_count: Int,
    cover_asset_id: String? = nil,
    generated_for: String
  ) {
    self.id = id
    self.theme = theme
    self.title = title
    self.subtitle = subtitle
    self.query = query
    self.result_count = result_count
    self.cover_asset_id = cover_asset_id
    self.generated_for = generated_for
  }
}

struct GeneratedSearchListResponse: Codable, Sendable {
  let results: [GeneratedSearchCard]
}

struct GeneratedSearchAssetsResponse: Codable, Sendable {
  let total: Int
  let results: [SearchAsset]
}

public actor GeneratedSearchClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  /// Sample client for SwiftUI `#Preview` and widget placeholder rendering.
  /// Points at an unreachable example server so any call fails fast, leaving
  /// the caller in its empty state rather than hanging a timeline refresh.
  public static func preview(
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> GeneratedSearchClient {
    GeneratedSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.preview(server: server)
    )
  }

  /// `GET /api/generated-searches?libraryId=<id>[&date=<YYYY-MM-DD>]`
  ///
  /// Omitting `date` asks for the most recent day that produced anything.
  /// That is what a widget wants: a late or empty run leaves yesterday's set
  /// on screen instead of blanking it.
  public func collections(
    libraryID: String,
    date: String? = nil
  ) async throws -> [GeneratedSearchCard] {
    var items = [URLQueryItem(name: "libraryId", value: libraryID)]
    if let date, !date.isEmpty {
      items.append(URLQueryItem(name: "date", value: date))
    }
    let (data, resp) = try await httpClient.data(
      for: URLRequest(url: makeURL(path: "/api/generated-searches", query: items))
    )
    try Self.checkOK(resp, data: data)
    return try JSONDecoder().decode(GeneratedSearchListResponse.self, from: data).results
  }

  /// `GET /api/generated-searches/<id>/assets?limit=<n>`
  ///
  /// The server re-derives the live query on every call, which is where the
  /// hidden-people and screenshot exclusions are applied. Always go through
  /// this rather than composing a `SearchParams` from a card.
  public func assets(collectionID: String, limit: Int = 50) async throws -> [SearchAsset] {
    let items = [URLQueryItem(name: "limit", value: String(limit))]
    let path = "/api/generated-searches/\(collectionID)/assets"
    let (data, resp) = try await httpClient.data(
      for: URLRequest(url: makeURL(path: path, query: items))
    )
    try Self.checkOK(resp, data: data)
    return try JSONDecoder().decode(GeneratedSearchAssetsResponse.self, from: data).results
  }

  // MARK: - Helpers

  private func makeURL(path: String, query: [URLQueryItem]) -> URL {
    var c = URLComponents(url: server.appending(path: path), resolvingAgainstBaseURL: false)!
    c.queryItems = query
    return c.url!
  }

  private static func checkOK(_ resp: URLResponse, data: Data) throws {
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw NSError(
        domain: "GeneratedSearchClient",
        code: (resp as? HTTPURLResponse)?.statusCode ?? -1,
        userInfo: [NSLocalizedDescriptionKey: body]
      )
    }
  }
}
