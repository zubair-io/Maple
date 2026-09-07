// CloudAddressResolver.swift
//
// Absolute server path → `slug:relPath` address for the unified routes
// (`/api/thumb|preview|image|folder/:slug/*`, #1325).
//
// Apple's cloud clients are keyed on absolute paths end to end —
// `SearchAsset.abs_path`, the `fs:<absPath>` `ImageRef` ids `CloudSource`
// mints, `/api/fs/dir` listings — so the translation happens here, at the
// HTTP edge, the same way the web's `FilesystemBrowseService
// .addressForAbsPath` does it: the registered libraries from `/api/folders`
// are the only source of (slug, root) pairs, the longest root that contains
// the path on a whole-segment boundary wins, and the list is loaded lazily
// once per resolver and shared across concurrent lookups.

import Foundation

/// One `slug:relPath` address. `relPath` is `""` for the library root.
public struct MapleAddress: Equatable, Sendable {
  public let slug: String
  public let relPath: String

  public init(slug: String, relPath: String) {
    self.slug = slug
    self.relPath = relPath
  }

  /// Wire form the server hands out (`/api/folder` entries,
  /// `/api/assets/by-fspath`'s `address`).
  public var string: String { "\(slug):\(relPath)" }

  /// Characters `encodeURIComponent` leaves bare. Everything else in a
  /// segment — spaces, `#`, `?`, `%`, non-ASCII — is percent-encoded, and
  /// `/` is never inside a segment, so the server's per-segment
  /// `decodeURIComponent` (`parseWildcardSegments`) recovers the exact
  /// filename. ASCII-only on purpose: `CharacterSet.alphanumerics` would
  /// leave `ü` bare and hand `URLComponents` a non-ASCII path.
  private static let bareSegmentCharacters = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

  /// `/api/<route>/<slug>/<seg>/<seg>` — the path portion of a unified
  /// route URL, each `relPath` segment percent-encoded. The library root
  /// (`relPath == ""`) is `/api/<route>/<slug>` with no trailing slash,
  /// which is the separately-registered root form of `/api/folder`.
  public func apiPath(route: String) -> String {
    let encoded = relPath.split(separator: "/", omittingEmptySubsequences: true)
      .map { String($0).addingPercentEncoding(withAllowedCharacters: Self.bareSegmentCharacters) ?? String($0) }
    return (["", "api", route, slug] + encoded).joined(separator: "/")
  }

  /// Full URL on `server` (which may carry a path prefix or trailing
  /// slash, e.g. `https://host:3000/maple/`). Built through
  /// `percentEncodedPath` so the already-encoded segments are not encoded
  /// a second time, as `URL.appending(path:)` would do.
  public func url(server: URL, route: String) -> URL {
    var components = URLComponents(url: server, resolvingAgainstBaseURL: false)!
    let base = components.percentEncodedPath
    let trimmed = base.hasSuffix("/") ? String(base.dropLast()) : base
    components.percentEncodedPath = trimmed + apiPath(route: route)
    return components.url!
  }

  /// Pure root match: the registered library whose root is the longest
  /// whole-segment ancestor of `absPath` (or the path itself) supplies the
  /// slug; the remainder is the relative path. Libraries with no slug are
  /// skipped — they have no unified address at all. `nil` when the path is
  /// under no registered library.
  public static func resolve(absPath: String, folders: [CloudFolder]) -> MapleAddress? {
    let candidates = folders.compactMap { folder -> (slug: String, root: String)? in
      guard let slug = folder.slug, !slug.isEmpty else { return nil }
      let root = folder.path == "/" ? "/" : Self.trimTrailingSlash(folder.path)
      return (slug, root)
    }
    let matches = candidates.compactMap { candidate -> MapleAddress? in
      if absPath == candidate.root {
        return MapleAddress(slug: candidate.slug, relPath: "")
      }
      let prefix = candidate.root == "/" ? "/" : candidate.root + "/"
      guard absPath.hasPrefix(prefix) else { return nil }
      return MapleAddress(slug: candidate.slug, relPath: String(absPath.dropFirst(prefix.count)))
    }
    // Longest root == shortest remaining relPath.
    return matches.min { $0.relPath.count < $1.relPath.count }
  }

  private static func trimTrailingSlash(_ path: String) -> String {
    path.hasSuffix("/") ? String(path.dropLast()) : path
  }
}

public enum CloudAddressError: Error, LocalizedError, Equatable {
  /// The path is under no registered library on this server, so no
  /// unified route can address it.
  case unregisteredPath(String)

  public var errorDescription: String? {
    switch self {
    case .unregisteredPath(let path):
      return "\(path) is not inside any registered library on this server"
    }
  }
}

/// Per-server translator from absolute paths to unified addresses. Loads
/// `/api/folders` once, lazily, sharing one in-flight request across
/// concurrent callers (a grid page fans out dozens of thumb requests at
/// once). A miss refreshes the list once — but only when the cached list
/// is at least `refreshAfter` old, so a burst of lookups for a path that
/// genuinely belongs to no library cannot turn into a `/api/folders`
/// storm — and throws `CloudAddressError.unregisteredPath` if the path is
/// still unknown.
public actor CloudAddressResolver {
  public nonisolated let server: URL
  private let folders: CloudFoldersClient
  private let refreshAfter: TimeInterval
  private var loaded: (folders: [CloudFolder], at: Date)?
  private var inflight: Task<[CloudFolder], Error>?

  public init(server: URL, httpClient: AuthenticatedHTTPClient, refreshAfter: TimeInterval = 10) {
    self.server = server
    self.folders = CloudFoldersClient(server: server, httpClient: httpClient)
    self.refreshAfter = refreshAfter
  }

  public func address(forAbsPath absPath: String) async throws -> MapleAddress {
    let (current, loadedAt) = try await load()
    if let hit = MapleAddress.resolve(absPath: absPath, folders: current) { return hit }
    // A library registered after this list was cached is the one legitimate
    // reason for a miss; give the server one chance to say so.
    guard Date().timeIntervalSince(loadedAt) >= refreshAfter else {
      throw CloudAddressError.unregisteredPath(absPath)
    }
    let (fresh, _) = try await load(forceRefresh: true)
    guard let hit = MapleAddress.resolve(absPath: absPath, folders: fresh) else {
      throw CloudAddressError.unregisteredPath(absPath)
    }
    return hit
  }

  /// `address(forAbsPath:)` + `MapleAddress.url(server:route:)` in one call.
  public func url(route: String, absPath: String) async throws -> URL {
    try await address(forAbsPath: absPath).url(server: server, route: route)
  }

  private func load(forceRefresh: Bool = false) async throws -> ([CloudFolder], Date) {
    if !forceRefresh, let loaded { return loaded }
    let task = inflight ?? Task { [folders] in try await folders.listFolders() }
    inflight = task
    defer { if inflight == task { inflight = nil } }
    let list = try await task.value
    let stamped = (folders: list, at: Date())
    loaded = stamped
    return stamped
  }
}
