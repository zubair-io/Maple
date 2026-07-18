// CloudPagesCache.swift
//
// On-disk JSON cache for /api/search responses. Keyed on
// (host, libraryID, year, month, page). Same stale-while-revalidate
// pattern as CloudBucketsCache.

import Foundation

public actor CloudPagesCache {
  public let baseDir: URL

  public init(baseDir: URL? = nil) {
    if let baseDir { self.baseDir = baseDir }
    else {
      let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
      self.baseDir = caches
        .appendingPathComponent("app.justmaple.aperture", isDirectory: true)
        .appendingPathComponent("cloud-pages", isDirectory: true)
    }
  }

  public func read(host: String, libraryID: String,
                   pathPrefix: String? = nil,
                   year: Int, month: Int, page: Int) -> SearchResponse? {
    let url = path(host: host, libraryID: libraryID,
                   pathPrefix: pathPrefix,
                   year: year, month: month, page: page)
    guard FileManager.default.fileExists(atPath: url.path),
          let data = try? Data(contentsOf: url),
          let resp = try? JSONDecoder().decode(SearchResponse.self, from: data)
    else { return nil }
    return resp
  }

  public func write(host: String, libraryID: String,
                    pathPrefix: String? = nil,
                    year: Int, month: Int, page: Int,
                    _ response: SearchResponse) {
    let url = path(host: host, libraryID: libraryID,
                   pathPrefix: pathPrefix,
                   year: year, month: month, page: page)
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true)
    if let data = try? JSONEncoder().encode(response) {
      try? data.write(to: url, options: .atomic)
    }
  }

  public func clearLibrary(host: String, libraryID: String) {
    let dir = baseDir
      .appendingPathComponent(host, isDirectory: true)
      .appendingPathComponent(libraryID, isDirectory: true)
    try? FileManager.default.removeItem(at: dir)
  }

  /// baseDir / host / libraryID / scope / YYYY-MM-pN.json — same scope
  /// segment scheme as CloudBucketsCache so the two caches' folder
  /// layouts mirror each other.
  private func path(host: String, libraryID: String,
                    pathPrefix: String?,
                    year: Int, month: Int, page: Int) -> URL {
    let scope = pathPrefix.flatMap(scopeDigest) ?? "_root"
    return baseDir
      .appendingPathComponent(host, isDirectory: true)
      .appendingPathComponent(libraryID, isDirectory: true)
      .appendingPathComponent(scope, isDirectory: true)
      .appendingPathComponent(String(format: "%04d-%02d-p%d.json", year, month, page))
  }
}
