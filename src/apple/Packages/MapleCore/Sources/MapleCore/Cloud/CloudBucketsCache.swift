// CloudBucketsCache.swift
//
// On-disk JSON cache for /api/search/buckets responses. Keyed on
// (host, libraryID). Stale-while-revalidate: caller renders cached
// counts immediately, kicks off a refetch in the background, swaps
// in fresh data when it arrives.

import Foundation

public actor CloudBucketsCache {
  public let baseDir: URL

  public init(baseDir: URL? = nil) {
    if let baseDir { self.baseDir = baseDir }
    else {
      let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
      self.baseDir = caches
        .appendingPathComponent("app.justmaple.aperture", isDirectory: true)
        .appendingPathComponent("cloud-buckets", isDirectory: true)
    }
  }

  public func read(host: String, libraryID: String) -> TimelineBuckets? {
    let url = path(host: host, libraryID: libraryID)
    guard FileManager.default.fileExists(atPath: url.path),
          let data = try? Data(contentsOf: url),
          let buckets = try? JSONDecoder().decode(TimelineBuckets.self, from: data)
    else { return nil }
    return buckets
  }

  public func write(host: String, libraryID: String, _ buckets: TimelineBuckets) {
    let url = path(host: host, libraryID: libraryID)
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true)
    if let data = try? JSONEncoder().encode(buckets) {
      try? data.write(to: url, options: .atomic)
    }
  }

  public func clear(host: String, libraryID: String) {
    try? FileManager.default.removeItem(at: path(host: host, libraryID: libraryID))
  }

  private func path(host: String, libraryID: String) -> URL {
    baseDir
      .appendingPathComponent(host, isDirectory: true)
      .appendingPathComponent("\(libraryID).json")
  }
}
