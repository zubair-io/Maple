// ImportsClient.swift — /api/imports/*, plus the /api/fs and /api/folders
// endpoints the wizard needs (#2773).
//
// Every route here sits under plain `requireAuth` (src/api/src/index.ts
// mounts `importsRoutes` and `fsRoutes` inside `authedApi`) — unlike
// /api/cloudflare there is no server-side owner check.
// `ServerAdminSection.isOwnerOnly` hides this page from members client-side
// to match the web nav filter, but that hiding is presentation only.

import Foundation

public actor ImportsClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient
  private let foldersClient: CloudFoldersClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
    self.foldersClient = CloudFoldersClient(server: server, httpClient: httpClient)
  }

  // MARK: - Step 1: library + source picker

  /// `GET /api/folders` — target libraries the wizard can import into.
  /// Delegates to `CloudFoldersClient` instead of re-decoding `CloudFolder`
  /// a second time.
  public func libraries() async throws -> [CloudFolder] {
    try await foldersClient.listFolders()
  }

  /// `GET /api/fs/roots` — the MAPLE_ROOTS jail roots, so the picker can
  /// open at the filesystem root rather than inside a library.
  public func roots() async throws -> [String] {
    let url = server.appending(path: "/api/fs/roots")
    let (data, resp) = try await httpClient.data(for: URLRequest(url: url))
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    struct Envelope: Decodable { let roots: [String] }
    return try JSONDecoder().decode(Envelope.self, from: data).roots
  }

  /// `GET /api/fs/dir-fast?path=` — one directory level of the SERVER's
  /// filesystem (see `ImportsDirListing`). Deliberately the `-fast`
  /// variant, not `/api/fs/dir`: the picker needs no EXIF/Mongo enrichment,
  /// only names and the jail-aware `parent`.
  public func browse(path: String) async throws -> ImportsDirListing {
    var components = URLComponents(
      url: server.appending(path: "/api/fs/dir-fast"), resolvingAgainstBaseURL: false)!
    components.queryItems = [URLQueryItem(name: "path", value: path)]
    let (data, resp) = try await httpClient.data(for: URLRequest(url: components.url!))
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(ImportsDirListing.self, from: data)
  }

  // MARK: - Step 2: scan

  /// `POST /api/imports/scan`. `libraryID` is optional server-side but
  /// should be sent whenever known — the target library is always chosen
  /// before the source folder in the wizard flow — since it's what lets the
  /// server also resolve nearby-asset matches into each bucket's
  /// `nearbyMatchCount`.
  public func scan(sourceRoot: String, libraryID: String?) async throws -> ImportScanResult {
    var request = URLRequest(url: server.appending(path: "/api/imports/scan"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(
      ImportScanRequest(sourceRoot: sourceRoot, libraryID: libraryID))
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(ImportScanResult.self, from: data)
  }

  // MARK: - Step 3: create + progress

  /// `POST /api/imports` — manual path when `labels` is supplied, Auto
  /// Import when `auto` is true (the server ignores `labels` in that case;
  /// callers should pass `nil` for the one that doesn't apply, mirroring
  /// the web's `queue()`). Returns the new import's id.
  public func create(
    sourceRoot: String, libraryID: String, labels: [String: String]?, auto: Bool?
  ) async throws -> String {
    var request = URLRequest(url: server.appending(path: "/api/imports"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(
      ImportCreateRequest(sourceRoot: sourceRoot, libraryID: libraryID, labels: labels, auto: auto))
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    struct Envelope: Decodable { let id: String }
    return try JSONDecoder().decode(Envelope.self, from: data).id
  }

  /// `GET /api/imports/:id?summary=1` — status/progress/counts WITHOUT the
  /// per-file `files` array. Progress polling must use this variant
  /// specifically: the full detail endpoint re-transfers every file's
  /// src/dest/state on every tick, which is fine for a one-off expanded row
  /// on the Workers page but not for a poll every 1.5s against a
  /// large import.
  public func status(id: String) async throws -> ImportSummary {
    var components = URLComponents(
      url: server.appending(path: "/api/imports/\(id)"), resolvingAgainstBaseURL: false)!
    components.queryItems = [URLQueryItem(name: "summary", value: "1")]
    let (data, resp) = try await httpClient.data(for: URLRequest(url: components.url!))
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
    return try JSONDecoder().decode(ImportSummary.self, from: data)
  }

  /// `POST /api/imports/:id/cancel`. 404s when the import is missing or
  /// already finished — surfaced as a plain `ServerAdminError` rather than
  /// special-cased, since a cancel racing the job's own completion is a
  /// normal outcome the next poll tick already resolves.
  public func cancel(id: String) async throws {
    try await post(path: "/api/imports/\(id)/cancel")
  }

  /// `POST /api/imports/:id/retry`. 409s when the job isn't in a retryable
  /// state — see `ImportSummary.isRetryable` for the client-side mirror of
  /// that guard, used to decide whether to offer the button at all.
  public func retry(id: String) async throws {
    try await post(path: "/api/imports/\(id)/retry")
  }

  private func post(path: String) async throws {
    var request = URLRequest(url: server.appending(path: path))
    request.httpMethod = "POST"
    let (data, resp) = try await httpClient.data(for: request)
    if let error = ServerAdminError.from(data: data, response: resp) { throw error }
  }

  public static func preview(
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> ImportsClient {
    ImportsClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.preview(server: server))
  }
}
