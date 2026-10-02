// CloudFoldersClient.swift
//
// Typed wrapper over `GET /api/folders`.

import Foundation

public actor CloudFoldersClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient
  // Lazy: the resolver owns a folders client for root discovery, which does
  // not itself need a resolver until listing directory contents (#4006).
  private lazy var addresses = CloudAddressResolver(server: server, httpClient: httpClient)

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  /// `fresh` bypasses the server's 30s per-root connectivity cache
  /// (#2898) — used by the server-admin Sources page's "Check again"
  /// action, where serving a cached answer would make the button a no-op.
  public func listFolders(fresh: Bool = false) async throws -> [CloudFolder] {
    var c = URLComponents(
      url: server.appending(path: "/api/folders"),
      resolvingAgainstBaseURL: false)!
    if fresh { c.queryItems = [URLQueryItem(name: "fresh", value: "1")] }
    let req = URLRequest(url: c.url!)
    let (data, resp) = try await httpClient.data(for: req)
    try Self.checkOK(resp, data: data)
    do {
      return try JSONDecoder().decode([CloudFolder].self, from: data)
    } catch {
      let preview = String(data: data.prefix(2048), encoding: .utf8) ?? "<non-utf8 \(data.count)B>"
      cloudHTTPLogger.error(
        "decode [CloudFolder] failed: \(error.localizedDescription, privacy: .public) — body preview: \(preview, privacy: .public)"
      )
      throw error
    }
  }

  /// Unified enriched listing for the sidebar's lazy tree drill-down.
  /// The registered root supplies the slug; unknown paths fail rather than
  /// falling back to the legacy filesystem route (#4006).
  public func listDir(absPath: String) async throws -> FsDirListing {
    let url = try await addresses.url(route: "folder", absPath: absPath)
    let req = URLRequest(url: url)
    let (data, resp) = try await httpClient.data(for: req)
    try Self.checkOK(resp, data: data)
    do {
      return try JSONDecoder().decode(FsDirListing.self, from: data)
    } catch {
      let preview = String(data: data.prefix(2048), encoding: .utf8) ?? "<non-utf8 \(data.count)B>"
      cloudHTTPLogger.error(
        "decode FsDirListing failed (sidebar, path \(absPath, privacy: .public)): \(error.localizedDescription, privacy: .public) — body preview: \(preview, privacy: .public)"
      )
      throw error
    }
  }

  private static func checkOK(_ resp: URLResponse, data: Data) throws {
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw NSError(
        domain: "CloudFoldersClient",
        code: (resp as? HTTPURLResponse)?.statusCode ?? -1,
        userInfo: [NSLocalizedDescriptionKey: body])
    }
  }
}
