// AuthUserCache.swift
//
// Persists the last-known AuthUser per server so AuthSession can present
// a signed-in state immediately on cold start without waiting for a
// successful /api/auth/me round-trip — which fails offline and used to
// force the sign-in sheet to appear over a perfectly valid Keychain
// token. The cache is read synchronously from the AuthSession init so
// `isSignedIn` is correct before the network call even begins.
//
// The cache is advisory. The Keychain is still the source of truth for
// authentication itself — we only fall back to the cached user when a
// network call fails transiently. On a real 401/403 we clear both the
// tokens and this cache.

import Foundation

public enum AuthUserCache {
  private static let folder = "auth-users"

  /// `Caches/app.justmaple.aperture/auth-users/<host>.json`. We key on
  /// host (not full URL) to match TokenStore's keying granularity for
  /// the common case where a server is reached via a single base URL.
  /// Pre-existing entries from other URL forms simply miss the cache.
  private static func url(for server: URL) -> URL? {
    guard let host = server.host else { return nil }
    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
    return caches
      .appendingPathComponent("app.justmaple.aperture", isDirectory: true)
      .appendingPathComponent(folder, isDirectory: true)
      .appendingPathComponent("\(host).json")
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
