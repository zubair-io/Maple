// CloudSource.swift
//
// `ImageSource` that talks to a Maple Cloud server, scoped to one
// registered library (folder). Lists files via `/api/fs/dir` —
// matching the web app's "Phase B browse" pattern — so the user
// sees subdirectory structure and the listing keeps up with the
// filesystem instead of waiting for the indexer.
//
// `ImageRef.id` is `fs:<absPath>` (same convention as the web's
// editor identifiers). Thumbnails and raw bytes are fetched by
// absolute path via `/api/fs/thumb` and `/api/fs/raw`.
//
// Limitations (carried over from web):
//   • Editing XMP requires a Mongo asset id — not available from
//     the FS-walk endpoints — so cloud XMP writes go through the
//     CloudSidecarStore path and only succeed once the indexer
//     has caught up.

import Foundation

public actor CloudSource {
  public let server: URL
  public let folderID: String
  public let libraryPath: String
  /// Absolute path being browsed at the moment. Defaults to the
  /// library root; bumped by `navigate(to:)` for subfolder drill-down.
  public private(set) var currentPath: String
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL,
              folderID: String,
              libraryPath: String,
              httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.folderID = folderID
    self.libraryPath = libraryPath
    self.currentPath = libraryPath
    self.httpClient = httpClient
  }

  /// Drill into a subfolder. The next `images()` call lists its contents.
  public func navigate(to absPath: String) {
    currentPath = absPath
  }

  // MARK: - URL helpers

  func url(_ path: String, query: [URLQueryItem] = []) -> URL {
    var c = URLComponents(url: server.appending(path: path), resolvingAgainstBaseURL: false)!
    if !query.isEmpty { c.queryItems = query }
    return c.url!
  }

  /// Strip the `fs:` prefix to recover the absolute path. Returns the
  /// input unchanged if no prefix is present (defensive).
  static func absPath(from refID: String) -> String {
    refID.hasPrefix("fs:") ? String(refID.dropFirst(3)) : refID
  }
}

extension CloudSource: ImageSource {
  /// Returns the IMMEDIATE image children of `currentPath`. Subfolders
  /// are not included in the returned list — they're surfaced via the
  /// listing's `dirs` separately. Single round-trip; no auto-pagination.
  public func images() async throws -> [ImageRef] {
    let listing = try await listDir(absPath: currentPath)
    let iso8601 = ISO8601DateFormatter()
    return listing.images.map { img in
      let captureDate = img.exif?.captured_at.flatMap { iso8601.date(from: $0) }
      return ImageRef(id: "fs:\(img.path)", displayName: img.name, url: nil,
                      captureDate: captureDate)
    }
  }

  /// Full directory listing — used by callers that also want subfolders
  /// (sidebar drill-down, breadcrumb navigation).
  public func listDir(absPath: String) async throws -> FsDirListing {
    let dirURL = url("/api/fs/dir",
                     query: [URLQueryItem(name: "path", value: absPath)])
    let req = URLRequest(url: dirURL)
    let (data, resp) = try await httpClient.data(for: req)
    try Self.checkOK(resp, data: data)
    do {
      return try JSONDecoder().decode(FsDirListing.self, from: data)
    } catch {
      let preview = String(data: data.prefix(2048), encoding: .utf8) ?? "<non-utf8 \(data.count)B>"
      cloudHTTPLogger.error("decode FsDirListing failed (path \(absPath, privacy: .public)): \(error.localizedDescription, privacy: .public) — body preview: \(preview, privacy: .public)")
      throw error
    }
  }

  public func thumb(for ref: ImageRef) async throws -> Data? {
    let abs = Self.absPath(from: ref.id)
    let thumbURL = url("/api/fs/thumb",
                      query: [URLQueryItem(name: "path", value: abs),
                              URLQueryItem(name: "size", value: "512")])
    return try await getOrNilOn404(thumbURL)
  }

  public func preview(for ref: ImageRef) async throws -> Data? {
    // /api/fs/* doesn't expose a separate preview-resolution endpoint.
    // Callers fall back to thumb when preview is nil.
    nil
  }

  public func rawBytes(for ref: ImageRef) async throws -> Data {
    let abs = Self.absPath(from: ref.id)
    let rawURL = url("/api/fs/raw",
                     query: [URLQueryItem(name: "path", value: abs)])
    let req = URLRequest(url: rawURL)
    let (data, resp) = try await httpClient.data(for: req)
    try Self.checkOK(resp, data: data)
    return data
  }

  public func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {
    // The XMP write endpoint requires a Mongo asset id, which the FS-walk
    // listing doesn't expose. Editing flows through CloudSidecarStore's
    // own /api/assets/<id>/xmp path once the indexer has assigned an id.
    // Calls here would 400 with "Invalid asset id" — surface a clear
    // error rather than firing a doomed request.
    throw NSError(domain: "CloudSource", code: -1, userInfo: [
      NSLocalizedDescriptionKey: "Use CloudSidecarStore for cloud XMP writes (requires asset id)."
    ])
    _ = sidecar
  }

  public func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }

  // MARK: - Helpers

  private func getOrNilOn404(_ url: URL) async throws -> Data? {
    let req = URLRequest(url: url)
    let (data, resp) = try await httpClient.data(for: req)
    if let http = resp as? HTTPURLResponse, http.statusCode == 404 { return nil }
    try Self.checkOK(resp, data: data)
    return data
  }

  static func checkOK(_ resp: URLResponse, data: Data) throws {
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw NSError(domain: "CloudSource",
                    code: (resp as? HTTPURLResponse)?.statusCode ?? -1,
                    userInfo: [NSLocalizedDescriptionKey: body])
    }
  }
}
