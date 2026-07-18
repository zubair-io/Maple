// AuthUserCache.swift
//
// Persists the last-known AuthUser per server so AuthSession can show
// account metadata (email, owner badge) in the UI before a successful
// /api/auth/me round-trip. The cache is NOT load-bearing for the
// signed-in / signed-out decision — AuthSession.hasCredentials (a sync
// Keychain check) is what backs `isSignedIn`. The cache is purely a UX
// nicety; a missing entry just means a fresh-looking sidebar until the
// next /me succeeds.
//
// Privacy: the cached AuthUser includes the user's email (PII) and is
// written as plain JSON under ~/Library/Caches/app.justmaple.aperture/
// auth-users/. That directory is readable by any process running as
// the user, and is included in Time Machine / iCloud backups of Caches
// if the user has those enabled. We accept this trade-off because the
// data is the user's OWN account info on their OWN machine — not third-
// party PII — and the alternative (Keychain) is heavyweight for what
// is fundamentally a UI cache. If AuthUser ever grows to include more
// sensitive fields (tokens, recovery keys, payment info, etc.) move
// this store to Keychain.

import Foundation

public enum AuthUserCache {
  private static let folder = "auth-users"

  /// `Caches/app.justmaple.aperture/auth-users/<key>.json`. The key
  /// includes both host AND port so two servers on the same hostname
  /// but different ports don't collide. Hosts can contain characters
  /// that filesystems mangle (IPv6 brackets, colons) or that fold on
  /// case-insensitive filesystems, so the key is lowercased and
  /// percent-encoded down to an ASCII-safe filename.
  private static func url(for server: URL) -> URL? {
    guard let key = AuthCacheKey.make(for: server) else { return nil }
    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
    return caches
      .appendingPathComponent("app.justmaple.aperture", isDirectory: true)
      .appendingPathComponent(folder, isDirectory: true)
      .appendingPathComponent("\(key).json")
  }

  public static func load(server: URL) -> AuthUser? {
    guard let url = url(for: server),
          FileManager.default.fileExists(atPath: url.path),
          let data = try? Data(contentsOf: url),
          let user = try? JSONDecoder().decode(AuthUser.self, from: data)
    else { return nil }
    return user
  }

  public static func save(_ user: AuthUser, server: URL) {
    guard let url = url(for: server) else { return }
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true)
    if let data = try? JSONEncoder().encode(user) {
      try? data.write(to: url, options: .atomic)
    }
  }

  public static func clear(server: URL) {
    guard let url = url(for: server) else { return }
    try? FileManager.default.removeItem(at: url)
  }
}

/// Shared helper for caches keyed on a server URL. Produces a stable,
/// filesystem-safe identifier that includes BOTH host and port (so
/// `https://x:8443` ≠ `https://x:9443`), lowercased (so case-insensitive
/// filesystems on macOS don't fold distinct hosts into one cache file),
/// and percent-encoded (so IPv6 literals like `[::1]`, internationalised
/// domain names, or any other characters the host might legally contain
/// don't break the filename).
///
/// Returns nil only when `server.host` itself is nil (e.g. a `file://`
/// URL with no host). Percent-encoding of a host is total in practice
/// because `URL.host` always produces a UTF-8 string, but if it ever
/// fails the nil return is logged so a silent cache miss doesn't go
/// undiagnosed — `load`/`save`/`clear` then no-op and the caller falls
/// back to live fetch / empty state.
public enum AuthCacheKey {
  public static func make(for server: URL) -> String? {
    guard let host = server.host else {
      authLogger.error("AuthCacheKey: no host for server \(server.absoluteString, privacy: .public) — cache disabled for this URL")
      return nil
    }
    let portSuffix = server.port.map { "_\($0)" } ?? ""
    let raw = (host + portSuffix).lowercased()
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
    guard let encoded = raw.addingPercentEncoding(withAllowedCharacters: allowed) else {
      authLogger.error("AuthCacheKey: failed to percent-encode host \(raw, privacy: .public) — cache disabled for this URL")
      return nil
    }
    return encoded
  }
}
