// NetworkConfigClient.swift — GET/PUT /api/network/config.
//
// Routes sit under plain `requireAuth` server-side (src/api/src/index.ts
// mounts networkSettingsRoutes inside authedApi), NOT requireOwner. The
// client hides the page from non-owners to match the web's nav filter,
// but that is a presentation choice and not a security boundary.

import Foundation

public actor NetworkConfigClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  private var configURL: URL { server.appending(path: "/api/network/config") }

  public func fetch() async throws -> NetworkConfig {
    let (data, resp) = try await httpClient.data(for: URLRequest(url: configURL))
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(NetworkConfig.self, from: data)
  }

  public func save(_ patch: NetworkConfigPatch) async throws -> NetworkConfig {
    var request = URLRequest(url: configURL)
    request.httpMethod = "PUT"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(patch)
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(NetworkConfig.self, from: data)
  }

  /// Sample client for SwiftUI `#Preview` blocks. Points at an
  /// unreachable server so requests fail fast and the preview renders its
  /// error state, mirroring `CloudHistogramClient.preview()`.
  public static func preview(
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> NetworkConfigClient {
    NetworkConfigClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.preview(server: server))
  }
}
