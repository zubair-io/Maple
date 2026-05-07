// CloudThumbCache.swift
//
// On-disk JPEG cache for cloud thumbnails. Keyed on the absolute path
// (because that's the server-side identity). LRU-evicted with a soft
// total-size cap (default 2 GB).

import CryptoKit
import Foundation

public actor CloudThumbCache {
  public let baseDir: URL
  public let maxBytes: Int64

  public init(baseDir: URL? = nil, maxBytes: Int64 = 2 * 1024 * 1024 * 1024) {
    if let baseDir { self.baseDir = baseDir }
    else {
      let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
      self.baseDir = caches
        .appendingPathComponent("app.justmaple.aperture", isDirectory: true)
        .appendingPathComponent("cloud-thumbs", isDirectory: true)
    }
    self.maxBytes = maxBytes
  }

  public func get(host: String, absPath: String) -> Data? {
    let url = path(host: host, absPath: absPath)
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    // Touch mtime so LRU sees the access.
    try? FileManager.default.setAttributes([.modificationDate: Date()],
                                           ofItemAtPath: url.path)
    return try? Data(contentsOf: url)
  }

  public func put(host: String, absPath: String, _ jpeg: Data) {
    let url = path(host: host, absPath: absPath)
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true)
    try? jpeg.write(to: url, options: .atomic)
    Task { await self.evictIfNeeded() }
  }

  public func evictIfNeeded() {
    let fm = FileManager.default
    guard let enumerator = fm.enumerator(
      at: baseDir,
      includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey],
      options: [.skipsHiddenFiles])
    else { return }

    struct Entry { let url: URL; let size: Int64; let mtime: Date }
    var entries: [Entry] = []
    var total: Int64 = 0
    for case let url as URL in enumerator {
      let v = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
      let size = Int64(v?.fileSize ?? 0)
      // Skip directories (no file size).
      guard size > 0 else { continue }
      let mtime = v?.contentModificationDate ?? .distantPast
      entries.append(Entry(url: url, size: size, mtime: mtime))
      total += size
    }
    guard total > maxBytes else { return }

    entries.sort { $0.mtime < $1.mtime }
    var i = 0
    while total > maxBytes && i < entries.count {
      try? fm.removeItem(at: entries[i].url)
      total -= entries[i].size
      i += 1
    }
  }

  private func path(host: String, absPath: String) -> URL {
    let digest = SHA256.hash(data: Data(absPath.utf8))
      .map { String(format: "%02x", $0) }.joined()
    return baseDir
      .appendingPathComponent(host, isDirectory: true)
      .appendingPathComponent(String(digest.prefix(2)), isDirectory: true)
      .appendingPathComponent("\(digest).jpg")
  }
}
