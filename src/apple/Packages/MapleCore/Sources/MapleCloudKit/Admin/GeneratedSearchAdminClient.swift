// GeneratedSearchAdminClient.swift — the generated-search worker's operator
// surface, for the native Workers settings page.
//
//   GET/PATCH /api/workers/generated-search/config — the daily run's knobs
//   POST      /api/workers/generated-search/run    — kick a pass now
//
// The collections themselves come from GeneratedSearchClient (Cloud/) — this
// client is only the operate-the-worker half.

import Foundation

/// Mirror of the server's `GeneratedSearchConfig`
/// (src/api/src/workers/generated-search/config.repo.ts). The worker ships
/// PAUSED; clearing `paused` is what turns the feature on.
public struct GeneratedSearchAdminConfig: Codable, Equatable, Sendable {
  public var collections_per_day: Int
  public var min_results: Int
  public var max_rounds: Int
  public var retention_days: Int
  /// Empty string means "inherit the describe stage's model".
  public var model: String
  public var paused: Bool
  public var dry_run: Bool
}

/// Partial PATCH body — only set fields are sent.
public struct GeneratedSearchAdminPatch: Codable, Sendable {
  public var collections_per_day: Int?
  public var min_results: Int?
  public var max_rounds: Int?
  public var retention_days: Int?
  public var model: String?
  public var paused: Bool?
  public var dry_run: Bool?

  public init(
    collections_per_day: Int? = nil,
    min_results: Int? = nil,
    max_rounds: Int? = nil,
    retention_days: Int? = nil,
    model: String? = nil,
    paused: Bool? = nil,
    dry_run: Bool? = nil
  ) {
    self.collections_per_day = collections_per_day
    self.min_results = min_results
    self.max_rounds = max_rounds
    self.retention_days = retention_days
    self.model = model
    self.paused = paused
    self.dry_run = dry_run
  }
}

public struct GeneratedSearchRunResult: Codable, Sendable {
  public let started: Bool
  public let reason: String?
}

public actor GeneratedSearchAdminClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  private var configURL: URL { server.appending(path: "/api/workers/generated-search/config") }
  private var runURL: URL { server.appending(path: "/api/workers/generated-search/run") }

  public func fetchConfig() async throws -> GeneratedSearchAdminConfig {
    let (data, resp) = try await httpClient.data(for: URLRequest(url: configURL))
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(GeneratedSearchAdminConfig.self, from: data)
  }

  /// The server clamps out-of-range knobs and answers with what it stored —
  /// callers must adopt the returned config, not their optimistic patch.
  public func save(_ patch: GeneratedSearchAdminPatch) async throws -> GeneratedSearchAdminConfig {
    struct PatchResponse: Codable { let config: GeneratedSearchAdminConfig }
    var request = URLRequest(url: configURL)
    request.httpMethod = "PATCH"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(patch)
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(PatchResponse.self, from: data).config
  }

  /// Kick one pass now. Returns immediately; `started: false` with
  /// `already-running` means a pass is in flight — not an error.
  public func runNow() async throws -> GeneratedSearchRunResult {
    var request = URLRequest(url: runURL)
    request.httpMethod = "POST"
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(GeneratedSearchRunResult.self, from: data)
  }

  public static func preview(
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> GeneratedSearchAdminClient {
    GeneratedSearchAdminClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.preview(server: server))
  }
}
