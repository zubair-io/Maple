// CloudFoldersClient.swift
//
// Typed wrapper over `GET /api/folders`.

import Foundation

public actor CloudFoldersClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  public func listFolders() async throws -> [CloudFolder] {
    let url = server.appending(path: "/api/folders")
    let req = URLRequest(url: url)
    let (data, resp) = try await httpClient.data(for: req)
    try Self.checkOK(resp, data: data)
    do {
      return try JSONDecoder().decode([CloudFolder].self, from: data)
    } catch {
      let preview = String(data: data.prefix(2048), encoding: .utf8) ?? "<non-utf8 \(data.count)B>"
      cloudHTTPLogger.error("decode [CloudFolder] failed: \(error.localizedDescription, privacy: .public) — body preview: \(preview, privacy: .public)")
      throw error
    }
  }

  /// `GET /api/fs/dir?path=<abs>` — one directory level (subdirs +
  /// images). Used by the sidebar's lazy tree drill-down. CloudSource
  /// has its own `listDir` that goes through the same endpoint; this
  /// one lives on the folders client so the sidebar doesn't need a
  /// per-folder source instance just to list a tree.
  public func listDir(absPath: String) async throws -> FsDirListing {
    var c = URLComponents(url: server.appending(path: "/api/fs/dir"),
                          resolvingAgainstBaseURL: false)!
    c.queryItems = [URLQueryItem(name: "path", value: absPath)]
    let req = URLRequest(url: c.url!)
    let (data, resp) = try await httpClient.data(for: req)
    try Self.checkOK(resp, data: data)
    do {
      return try JSONDecoder().decode(FsDirListing.self, from: data)
    } catch {
      let preview = String(data: data.prefix(2048), encoding: .utf8) ?? "<non-utf8 \(data.count)B>"
      cloudHTTPLogger.error("decode FsDirListing failed (sidebar, path \(absPath, privacy: .public)): \(error.localizedDescription, privacy: .public) — body preview: \(preview, privacy: .public)")
      throw error
    }
  }

  private static func checkOK(_ resp: URLResponse, data: Data) throws {
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw NSError(domain: "CloudFoldersClient",
                    code: (resp as? HTTPURLResponse)?.statusCode ?? -1,
                    userInfo: [NSLocalizedDescriptionKey: body])
    }
  }
}
