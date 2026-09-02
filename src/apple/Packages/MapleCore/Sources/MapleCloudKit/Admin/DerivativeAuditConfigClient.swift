// DerivativeAuditConfigClient.swift — GET /api/derivative-audit/status,
// PUT /api/derivative-audit/config, POST /api/derivative-audit/run
// (T5b, #2772).

import Foundation

public actor DerivativeAuditConfigClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  public func status() async throws -> DerivativeAuditStatus {
    let (data, resp) = try await httpClient.data(
      for: URLRequest(url: server.appending(path: "/api/derivative-audit/status")))
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(DerivativeAuditStatus.self, from: data)
  }

  public func save(_ patch: DerivativeAuditConfigPatch) async throws -> DerivativeAuditConfig {
    struct Response: Decodable { let ok: Bool; let config: DerivativeAuditConfig }
    var request = URLRequest(url: server.appending(path: "/api/derivative-audit/config"))
    request.httpMethod = "PUT"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(patch)
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(Response.self, from: data).config
  }

  /// Kick a pass now. Shares the worker's single-flight lock server-side, so
  /// this can never start a second pass concurrent with a scheduled one.
  public func run() async throws -> DerivativeAuditRunResult {
    var request = URLRequest(url: server.appending(path: "/api/derivative-audit/run"))
    request.httpMethod = "POST"
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(DerivativeAuditRunResult.self, from: data)
  }

  public static func preview(
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> DerivativeAuditConfigClient {
    DerivativeAuditConfigClient(
      server: server, httpClient: AuthenticatedHTTPClient.preview(server: server))
  }
}
