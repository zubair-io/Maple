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

  // MARK: - Triage (#2769)

  /// Jobs `stage` gave up on. `limit` matches the web's default page size.
  public func deadJobs(stage: String, limit: Int = 50) async throws -> [DeadJob] {
    let url = server
      .appending(path: "/api/workers/\(stage)/dead")
      .appending(queryItems: [URLQueryItem(name: "limit", value: String(limit))])
    return try await get(url, as: DeadJobsResponse.self).items
  }

  /// Assets parked as unreadable, newest first. Not stage-scoped — a
  /// damaged asset is out of the pipeline entirely.
  public func damagedAssets(limit: Int = 200) async throws -> [DamagedAsset] {
    let url = server
      .appending(path: "/api/workers/damaged")
      .appending(queryItems: [URLQueryItem(name: "limit", value: String(limit))])
    return try await get(url, as: DamagedAssetsResponse.self).items
  }

  /// Re-arm every dead job on `stage`.
  @discardableResult
  public func retryDead(stage: String) async throws -> TriageMutationResult {
    let response = try await postReturning(
      path: "/api/workers/\(stage)/retry-dead", body: nil, as: RetryDeadResponse.self)
    return TriageMutationResult(affected: response.reset)
  }

  /// Clear the damaged tag and re-queue. `id` nil clears every damaged
  /// asset — the server treats a missing id as "all", so callers must be
  /// deliberate about passing nil.
  @discardableResult
  public func clearDamaged(id: String?) async throws -> TriageMutationResult {
    let body = id.map { ["id": $0] }
    let response = try await postReturning(
      path: "/api/workers/damaged/clear", body: body, as: ClearDamagedResponse.self)
    return TriageMutationResult(affected: response.cleared)
  }

  // MARK: - Transport

  private func get<T: Decodable>(_ url: URL, as type: T.Type) async throws -> T {
    let (data, resp) = try await httpClient.data(for: URLRequest(url: url))
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(T.self, from: data)
  }

  private func postReturning<T: Decodable>(
    path: String, body: [String: String]?, as type: T.Type
  ) async throws -> T {
    var request = URLRequest(url: server.appending(path: path))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    // Send `{}` rather than no body when there's nothing to say: the route
    // parses JSON and a zero-length body is not valid JSON.
    request.httpBody = try JSONSerialization.data(withJSONObject: body ?? [:])
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(T.self, from: data)
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
