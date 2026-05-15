// CloudFoldersCache.swift
//
// On-disk cache for `GET /api/folders` responses, keyed by server host.
// The sidebar reads from this cache as a fallback when the live request
// fails (e.g. offline) so the user sees the last-known library list
// instead of an empty sidebar.
//
// Pattern matches CloudBucketsCache: write on every successful fetch,
// read when the live call errors. The cache is advisory — a stale list
// is preferable to no list at all, and the next online fetch overwrites.

import Foundation

public enum CloudFoldersCache {
  private static let folder = "cloud-folders"

  private static func url(for server: URL) -> URL? {
    guard let host = server.host else { return nil }
    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
    return caches
      .appendingPathComponent("app.justmaple.aperture", isDirectory: true)
      .appendingPathComponent(folder, isDirectory: true)
      .appendingPathComponent("\(host).json")
  }

  public static func load(server: URL) -> [CloudFolder]? {
    guard let url = url(for: server),
          FileManager.default.fileExists(atPath: url.path),
          let data = try? Data(contentsOf: url),
          let folders = try? JSONDecoder().decode([CloudFolder].self, from: data)
    else { return nil }
    return folders
  }

  public static func save(_ folders: [CloudFolder], server: URL) {
    guard let url = url(for: server) else { return }
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true)
    if let data = try? JSONEncoder().encode(folders) {
      try? data.write(to: url, options: .atomic)
    }
  }

  public static func clear(server: URL) {
    guard let url = url(for: server) else { return }
    try? FileManager.default.removeItem(at: url)
  }
}
