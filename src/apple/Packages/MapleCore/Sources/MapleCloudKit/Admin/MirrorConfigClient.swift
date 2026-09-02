// MirrorConfigClient.swift — GET/PUT /api/folders/:id/mirror,
// POST /api/mirror/test, GET /api/mirror/status, POST /api/mirror/reconcile,
// POST /api/mirror/retry-dead (T5b, #2772).
//
// All routes sit under plain `requireAuth` (src/api/src/routes/mirror.ts) —
// no owner gate, unlike the enrichment PUT.

import Foundation

public actor MirrorConfigClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  public func mirrors(forLibrary libraryID: String) async throws -> [MirrorLocation] {
    struct Response: Decodable { let mirrors: [MirrorLocation] }
    let url = server.appending(path: "/api/folders/\(libraryID)/mirror")
    let (data, resp) = try await httpClient.data(for: URLRequest(url: url))
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(Response.self, from: data).mirrors
  }

  /// Replaces the whole mirror set for one library. This UI only ever shows
  /// one mirror per library, so callers pass a single-element (or empty, to
  /// clear) array.
  @discardableResult
  public func setMirrors(_ mirrors: [MirrorLocation], forLibrary libraryID: String) async throws
    -> [MirrorLocation]
  {
    struct Body: Encodable { let mirrors: [MirrorLocation] }
    struct Response: Decodable { let ok: Bool; let mirrors: [MirrorLocation] }
    var request = URLRequest(url: server.appending(path: "/api/folders/\(libraryID)/mirror"))
    request.httpMethod = "PUT"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(Body(mirrors: mirrors))
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(Response.self, from: data).mirrors
  }

  /// Validate a candidate mirror path without saving (the "Test" button).
  public func testPath(_ path: String) async throws -> MirrorTestResult {
    struct Body: Encodable { let path: String }
    var request = URLRequest(url: server.appending(path: "/api/mirror/test"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(Body(path: path))
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(MirrorTestResult.self, from: data)
  }

  /// Standing queue depth plus live reconcile progress.
  public func status() async throws -> MirrorQueueStatus {
    let (data, resp) = try await httpClient.data(
      for: URLRequest(url: server.appending(path: "/api/mirror/status")))
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(MirrorQueueStatus.self, from: data)
  }

  /// Kick a full reconcile (scan → copy) now. Returns immediately; progress
  /// is then polled via `status()`. A run already in flight is a no-op.
  public func reconcile() async throws -> MirrorReconcileStartResult {
    var request = URLRequest(url: server.appending(path: "/api/mirror/reconcile"))
    request.httpMethod = "POST"
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(MirrorReconcileStartResult.self, from: data)
  }

  /// Re-arm every dead-lettered mirror copy. Returns how many rows were revived.
  @discardableResult
  public func retryDead() async throws -> Int {
    struct Response: Decodable { let ok: Bool; let revived: Int }
    var request = URLRequest(url: server.appending(path: "/api/mirror/retry-dead"))
    request.httpMethod = "POST"
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(Response.self, from: data).revived
  }

  public static func preview(
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> MirrorConfigClient {
    MirrorConfigClient(server: server, httpClient: AuthenticatedHTTPClient.preview(server: server))
  }
}
