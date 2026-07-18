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

  public func read(host: String, libraryID: String, pathPrefix: String? = nil) -> TimelineBuckets? {
    let url = path(host: host, libraryID: libraryID, pathPrefix: pathPrefix)
    guard FileManager.default.fileExists(atPath: url.path),
          let data = try? Data(contentsOf: url),
          let buckets = try? JSONDecoder().decode(TimelineBuckets.self, from: data)
    else { return nil }
    return buckets
  }

  public func write(host: String, libraryID: String, pathPrefix: String? = nil, _ buckets: TimelineBuckets) {
    let url = path(host: host, libraryID: libraryID, pathPrefix: pathPrefix)
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true)
    if let data = try? JSONEncoder().encode(buckets) {
      try? data.write(to: url, options: .atomic)
    }
  }

  public func clear(host: String, libraryID: String, pathPrefix: String? = nil) {
    try? FileManager.default.removeItem(at: path(host: host, libraryID: libraryID, pathPrefix: pathPrefix))
  }

  /// Path layout:
  ///   baseDir / host / libraryID / scope.json
  /// where `scope` is either `"_root"` (no pathPrefix) or a stable
  /// digest of the prefix string. We don't bake the raw prefix into
  /// the filename because absPaths can be long and contain characters
  /// that file systems mangle; the digest stays stable across launches.
  private func path(host: String, libraryID: String, pathPrefix: String?) -> URL {
    let scope = pathPrefix.flatMap(scopeDigest) ?? "_root"
    return baseDir
      .appendingPathComponent(host, isDirectory: true)
      .appendingPathComponent(libraryID, isDirectory: true)
      .appendingPathComponent("\(scope).json")
  }
}

/// 12-char DJB2 digest over UTF-8 bytes — collision-resistant enough
/// for this use case (per-library scope labels) and dependency-free.
func scopeDigest(_ s: String) -> String {
  var h: UInt64 = 5381
  for b in s.utf8 { h = (h &* 33) &+ UInt64(b) }
  return String(format: "%012llx", h)
}
