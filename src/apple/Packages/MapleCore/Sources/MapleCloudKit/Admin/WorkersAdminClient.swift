// WorkersAdminClient.swift — the HTTP half of /api/workers.
//
// Note these routes are `requireAuth` only, NOT `requireOwner`
// (src/api/src/workers/routes-main.ts) — unlike /api/cloudflare. Hiding the
// Workers page from members is a presentation choice, not a boundary.

import Foundation

public actor WorkersAdminClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  /// One-shot snapshot. Always carries counted numbers, unlike the socket's
  /// first frames — see `WorkersFeed`.
  public func status() async throws -> WorkersStatusPayload {
    let url = server.appending(path: "/api/workers/status")
    let (data, resp) = try await httpClient.data(for: URLRequest(url: url))
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(WorkersStatusPayload.self, from: data)
  }

  public func pause(stage: String) async throws {
    try await post(path: "/api/workers/\(stage)/pause")
  }

  public func resume(stage: String) async throws {
    try await post(path: "/api/workers/\(stage)/resume")
  }

  private func post(path: String) async throws {
    var request = URLRequest(url: server.appending(path: path))
    request.httpMethod = "POST"
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
  }

  public static func preview(
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> WorkersAdminClient {
    WorkersAdminClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.preview(server: server))
  }
}
