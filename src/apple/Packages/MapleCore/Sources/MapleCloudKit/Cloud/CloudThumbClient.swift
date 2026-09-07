// CloudThumbClient.swift
//
// Wraps `GET /api/thumb/:slug/*` and `GET /api/preview/:slug/*` — the
// unified-addressing derivative routes (#1325), the same URLs the web grid
// and the Cloudflare thumb Worker key on. The Apple Timeline / Search / Map
// grids ask for thumbnails by *absolute path* (`CloudSearchClient
// .SearchAsset.abs_path`); `CloudAddressResolver` translates that into the
// `slug:relPath` address per request, loading `/api/folders` once per
// client.

import Foundation

public actor CloudThumbClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient
  private let addresses: CloudAddressResolver

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
    self.addresses = CloudAddressResolver(server: server, httpClient: httpClient)
  }

  /// Returns AVIF bytes for the grid thumbnail of `absPath`.
  ///
  /// There is no `size` parameter: the server keeps ONE fixed thumbnail
  /// tier per source image (#2220). Use ``preview(absPath:)`` for the
  /// ~1280px display tier.
  ///
  /// Throws on anything but a 200 (caller surfaces the error or shows a
  /// placeholder cell), including `CloudAddressError` when `absPath` is
  /// under no registered library on this server.
  public func thumb(absPath: String) async throws -> Data {
    try await fetch(addresses.url(route: "thumb", absPath: absPath))
  }

  /// Returns AVIF bytes for the display-resolution (1280 px long-edge)
  /// preview of `absPath` — the tier the Preview screen swaps in over the
  /// grid thumbnail.
  ///
  /// Throws on anything but a 200. That includes the route's `202`
  /// "indexing" reply (a JSON body with `Retry-After: 2`, sent until the
  /// indexer has assigned the asset a `maple_id`) — there are no pixels to
  /// return, and every caller already falls back to the thumbnail on a
  /// throw, so the 202 is surfaced as an error carrying that status code.
  public func preview(absPath: String) async throws -> Data {
    try await fetch(addresses.url(route: "preview", absPath: absPath))
  }

  private func fetch(_ url: URL) async throws -> Data {
    let (data, resp) = try await httpClient.data(for: URLRequest(url: url))
    let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
    guard status == 200 else {
      throw NSError(
        domain: "CloudThumbClient",
        code: status,
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
