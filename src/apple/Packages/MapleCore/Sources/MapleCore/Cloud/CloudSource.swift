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
import MapleCloudKit

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

  /// Display-resolution (1280 px long-edge) preview via `/api/fs/preview` —
  /// the server generates it on demand into the folder's `.maple/previews/`
  /// (shared with the indexer's preview stage artifact) and caches it there.
  /// nil on 404/415 so the Preview screen keeps showing the thumbnail.
  public func preview(for ref: ImageRef) async throws -> Data? {
    let abs = Self.absPath(from: ref.id)
    let previewURL = url("/api/fs/preview",
                         query: [URLQueryItem(name: "path", value: abs)])
    return try await getOrNilOn404(previewURL)
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

  /// Seekable streaming URL for AVPlayer. The endpoint self-authenticates via
  /// query token because AVPlayer cannot attach the bearer header.
  public func videoURL(for refID: String) async throws -> URL {
    let abs = Self.absPath(from: refID)
    let token = try await httpClient.accessTokenForURL()
    return url("/api/video/fs", query: [
      URLQueryItem(name: "path", value: abs),
      URLQueryItem(name: "token", value: token),
    ])
  }

  /// Download the full RAW bytes for `ref` while reporting byte-level
  /// progress (#822). Routes through `session.download(for:)` on a session
  /// configured with a `DownloadProgressDelegate` — the non-buffered transport
  /// the auth client's `refreshIfNeededAndRetry` helper was built for (it
  /// streams to a temp file instead of holding the whole response in memory)
  /// — and that delegate forwards `totalBytesWritten` /
  /// `totalBytesExpectedToWrite` to `onProgress`.
  ///
  /// `expectedTotal` is the caller's best-known size (the catalog
  /// `SearchAsset.size`), used to seed the progress total before the
  /// response headers arrive and as a fallback when the server omits a
  /// `Content-Length` (the delegate reports `-1` then). Once headers land,
  /// the delegate's `totalBytesExpectedToWrite` supersedes it.
  ///
  /// `onProgress` is `@Sendable` and is invoked off the actor (from the
  /// `URLSession` delegate queue); the caller is responsible for hopping to
  /// whatever actor the progress sink lives on and for throttling. The
  /// returned `Data` is the fully-downloaded file, matching `rawBytes`.
  public func rawBytesWithProgress(
    for ref: ImageRef,
    expectedTotal: Int64?,
    onProgress: @escaping @Sendable (_ received: Int64, _ total: Int64?) -> Void
  ) async throws -> Data {
    let abs = Self.absPath(from: ref.id)
    let rawURL = url("/api/fs/raw",
                     query: [URLQueryItem(name: "path", value: abs)])
    let req = URLRequest(url: rawURL)

    // The progress delegate is its own URLSession's delegate (a delegate is
    // bound to a session, not a single task), so build a one-shot session
    // for this download. `expectedTotal` seeds the reported total so a
    // server without a Content-Length still yields a determinate bar.
    let delegate = DownloadProgressDelegate(
      fallbackTotal: expectedTotal, onProgress: onProgress)
    // Use an ephemeral configuration so a multi-hundred-MB RAW body is never
    // persisted to the shared URLCache, cookie storage, or credential storage
    // (mirrors `RemoteCatalog`'s download session). Auth is handled per-request
    // by the `AuthenticatedHTTPClient.refreshIfNeededAndRetry` wrapper below,
    // not by session-level headers, so nothing else needs to move here.
    let cfg = URLSessionConfiguration.ephemeral
    // `.ephemeral` already nils urlCache/cookies/credentials; the assignments
    // below are belt-and-suspenders + intent-as-doc.
    cfg.urlCache = nil
    cfg.httpCookieStorage = nil
    cfg.urlCredentialStorage = nil
    let session = URLSession(configuration: cfg,
                             delegate: delegate, delegateQueue: nil)
    defer { session.invalidateAndCancel() }

    let (fileURL, resp) = try await httpClient.refreshIfNeededAndRetry(request: req) { injected in
      try await session.download(for: injected)
    }

    // `download` writes to a temp file the system reclaims when this scope
    // exits — read it into memory before that happens. The pipeline wants
    // the bytes in `Data` (it has no streaming-decode entry point), so the
    // peak-memory cost matches the existing buffered `rawBytes` path.
    let data = try Data(contentsOf: fileURL)
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

  /// Free-text search against `GET /api/search`, scoped to this source's
  /// library. The richer filter UI drives `CloudSearchClient` directly via
  /// `SearchViewModel`; this protocol entry point covers the minimal
  /// `q`/limit/offset envelope so generic `ImageSource` callers can search
  /// a cloud library without knowing the full param surface.
  public func search(_ query: SearchQuery) async throws -> [ImageRef]? {
    var params = SearchParams(libraryID: folderID)
    params.q = query.q
    let client = CloudSearchClient(server: server, httpClient: httpClient)
    let limit = max(1, query.limit ?? 100)
    let offset = max(0, query.offset ?? 0)

    // The server paginates by page, not offset. Fetch the page(s) spanning
    // [offset, offset + limit) and slice, so a non-aligned offset (e.g. 50
    // with limit 100) returns that exact window instead of silently
    // snapping to the page boundary.
    let dropFront = offset % limit
    var collected: [SearchAsset] = []
    var page = offset / limit
    while collected.count < dropFront + limit {
      let resp = try await client.search(params, page: page, limit: limit)
      collected.append(contentsOf: resp.results)
      if resp.results.count < limit { break }  // reached the last page
      page += 1
    }
    let window = collected.dropFirst(dropFront).prefix(limit)

    let iso8601 = ISO8601DateFormatter()
    return window.map { a in
      ImageRef(id: a.id, displayName: a.filename, url: nil,
               captureDate: a.captured_at.flatMap { iso8601.date(from: $0) })
    }
  }

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
