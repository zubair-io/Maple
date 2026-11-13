// CloudPagesCache.swift
//
// On-disk JSON cache for /api/search responses. Keyed on
// (host, libraryID, pathPrefix, ownerID, year, month, page). Same stale-while-revalidate
// pattern as CloudBucketsCache.

import Foundation

public actor CloudPagesCache {
  public let baseDir: URL

  public init(baseDir: URL? = nil) {
    if let baseDir {
      self.baseDir = baseDir
    } else {
      let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
      self.baseDir =
        caches
        .appendingPathComponent("app.justmaple.aperture", isDirectory: true)
        .appendingPathComponent("cloud-pages", isDirectory: true)
    }
  }

  public func read(
    host: String, libraryID: String,
    pathPrefix: String? = nil,
    ownerID: String? = nil,
    year: Int, month: Int, page: Int
  ) -> SearchResponse? {
    let url = path(
      host: host, libraryID: libraryID,
      pathPrefix: pathPrefix, ownerID: ownerID,
      year: year, month: month, page: page)
    guard FileManager.default.fileExists(atPath: url.path),
      let data = try? Data(contentsOf: url),
      let resp = try? JSONDecoder().decode(SearchResponse.self, from: data)
    else { return nil }
    return resp
  }

  public func write(
    host: String, libraryID: String,
    pathPrefix: String? = nil,
    ownerID: String? = nil,
    year: Int, month: Int, page: Int,
    _ response: SearchResponse
  ) {
    let url = path(
      host: host, libraryID: libraryID,
      pathPrefix: pathPrefix, ownerID: ownerID,
      year: year, month: month, page: page)
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true)
    if let data = try? JSONEncoder().encode(response) {
      try? data.write(to: url, options: .atomic)
    }
  }

  public func clearLibrary(host: String, libraryID: String) {
    let dir =
      baseDir
      .appendingPathComponent(host, isDirectory: true)
      .appendingPathComponent(libraryID, isDirectory: true)
    try? FileManager.default.removeItem(at: dir)
  }

  /// Drops every cached page of every server. A server's 'Show one image for RAW+JPEG pairs' decides
  /// how its pages fold (#5050) and is not part of the key, so a change to it must clear the pages
  /// of Timelines no view model holds right now as well: their next load paints the cache first.
  public func clearAll() {
    try? FileManager.default.removeItem(at: baseDir)
  }

  /// baseDir / host / libraryID / scope / YYYY-MM-pN.json — same scope
  /// segment scheme as CloudBucketsCache so the two caches' folder
  /// layouts mirror each other.
  private func path(
    host: String, libraryID: String,
    pathPrefix: String?,
    ownerID: String?,
    year: Int, month: Int, page: Int
  ) -> URL {
    let scope = cloudOwnerScope(pathPrefix: pathPrefix, ownerID: ownerID)
    return
      baseDir
      .appendingPathComponent(host, isDirectory: true)
      .appendingPathComponent(libraryID, isDirectory: true)
      .appendingPathComponent(scope, isDirectory: true)
      .appendingPathComponent(String(format: "%04d-%02d-p%d.json", year, month, page))
  }
}
