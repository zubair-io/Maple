// CloudHistogramClient.swift
//
// Wraps `GET /api/assets/:id/histogram` (closes #633). Used by the S6
// Info panel's HistogramBlock to populate live RGB curves for assets that
// live on a Self-Hosted server. Local-only assets (filesystem / PhotoKit)
// don't have an asset id on the server, so the InfoPanel keeps the
// placeholder block for them — wiring threads `nil` and the block falls
// back automatically.
//
// The asset id on the wire is the Mongo `ObjectId` hex string the server
// uses everywhere else under `/api/assets/:id` — see
// `AppShell+CloudActions.swift` where `SearchAsset.id` is propagated into
// `AssetRef.stableID` for cloud-shaped sources.

import Foundation

/// Wire shape returned by `GET /api/assets/:id/histogram`. Three 256-bin
/// arrays of unnormalised counts; the renderer normalises per-channel
/// before drawing so a single hot bin doesn't flatten the rest.
public struct CloudHistogram: Decodable, Equatable, Sendable {
  public let r: [Int]
  public let g: [Int]
  public let b: [Int]

  public init(r: [Int], g: [Int], b: [Int]) {
    self.r = r
    self.g = g
    self.b = b
  }
}

public actor CloudHistogramClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  /// Fetch the histogram for `assetID` (Mongo ObjectId hex). Throws on
  /// any non-2xx response — callers fall back to the placeholder.
  ///
  /// The server's ETag is `"raw_mtime-xmp_mtime"`, so URLSession's
  /// default disk cache will serve revalidated 304s on subsequent
  /// fetches of the same edit-state without re-computing on the server.
  public func histogram(assetID: String) async throws -> CloudHistogram {
    let url = server
      .appending(path: "/api/assets/")
      .appending(path: assetID)
      .appending(path: "histogram")
    let (data, resp) = try await httpClient.data(for: URLRequest(url: url))
    if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
      throw NSError(
        domain: "CloudHistogramClient",
        code: http.statusCode,
        userInfo: [NSLocalizedDescriptionKey: String(data: data, encoding: .utf8) ?? ""])
    }
    return try JSONDecoder().decode(CloudHistogram.self, from: data)
  }

  /// Sample client for SwiftUI `#Preview` blocks. Points at an unreachable
  /// example server so requests fail fast; blocks fall back to placeholder
  /// imagery, which is what the preview wants to show anyway. Mirrors the
  /// existing `CloudThumbClient.preview()` shape.
  public static func preview(
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> CloudHistogramClient {
    CloudHistogramClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.preview(server: server)
    )
  }
}
