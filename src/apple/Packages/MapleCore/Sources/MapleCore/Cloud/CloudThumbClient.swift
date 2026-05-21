// CloudThumbClient.swift
//
// Wraps GET /api/fs/thumb?path=<abs>&size=512. The Apple Timeline grid
// asks for thumbnails by *absolute path* (the wire-level identifier the
// server uses for thumbs); CloudSearchClient.SearchAsset.abs_path is the
// source of those paths.

import Foundation

public actor CloudThumbClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  /// Returns JPEG bytes for the thumbnail of `absPath` at the given size.
  /// Throws on non-2xx responses (caller surfaces the error or shows a
  /// placeholder cell).
  public func thumb(absPath: String, size: Int = 512) async throws -> Data {
    var c = URLComponents(url: server.appending(path: "/api/fs/thumb"),
                          resolvingAgainstBaseURL: false)!
    c.queryItems = [
      URLQueryItem(name: "path", value: absPath),
      URLQueryItem(name: "size", value: "\(size)"),
    ]
    let (data, resp) = try await httpClient.data(for: URLRequest(url: c.url!))
    if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
      throw NSError(domain: "CloudThumbClient",
                    code: http.statusCode,
                    userInfo: [NSLocalizedDescriptionKey: String(data: data, encoding: .utf8) ?? ""])
    }
    return data
  }

  /// Sample client for SwiftUI `#Preview` blocks. Points at an unreachable
  /// example server so requests fail fast; cells fall back to placeholder
  /// imagery, which is what the preview wants to show anyway. Issue #139.
  public static func preview(
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> CloudThumbClient {
    CloudThumbClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.preview(server: server)
    )
  }
}
