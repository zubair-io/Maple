// CloudflareConfigClient.swift — GET/PUT /api/cloudflare/config, POST /test.
//
// These routes are `requireAuth` + `requireOwner` (src/api/src/routes/
// cloudflare.ts), so a member genuinely gets 403 here — unlike the network
// routes, where owner-only is a client-side nav convention.

import Foundation

public actor CloudflareConfigClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  private var configURL: URL { server.appending(path: "/api/cloudflare/config") }
  private var testURL: URL { server.appending(path: "/api/cloudflare/test") }

  public func fetch() async throws -> CloudflareConfig {
    let (data, resp) = try await httpClient.data(for: URLRequest(url: configURL))
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(CloudflareConfig.self, from: data)
  }

  /// Persist the patch.
  ///
  /// When `enabled` is true the server validates the merged credentials by
  /// round-tripping R2 *before* writing anything, so this can throw a 502
  /// with nothing saved. Callers must not treat a thrown error as "probably
  /// saved" — the stored config is unchanged in that case.
  public func save(_ patch: CloudflareConfigPatch) async throws -> CloudflareConfig {
    var request = URLRequest(url: configURL)
    request.httpMethod = "PUT"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(patch)
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(CloudflareConfig.self, from: data)
  }

  /// Probe credentials without saving them. Note this *writes* to the
  /// bucket: the server PUTs a zero-byte probe object and best-effort
  /// deletes it (`r2-client.ts`).
  ///
  /// Throws `ServerAdminError` on failure; the 502 body carries the reason
  /// in the same `error` key as every other admin route.
  public func test(_ credentials: CloudflareTestCredentials) async throws {
    var request = URLRequest(url: testURL)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(credentials)
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
  }

  public static func preview(
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> CloudflareConfigClient {
    CloudflareConfigClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.preview(server: server))
  }
}
