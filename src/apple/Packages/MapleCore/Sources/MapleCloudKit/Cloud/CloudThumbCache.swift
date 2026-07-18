// CloudThumbCache.swift
//
// On-disk AVIF cache for cloud thumbnails. Keyed on the absolute path
// (because that's the server-side identity). LRU-evicted with a soft
// total-size cap (default 2 GB).

import CryptoKit
import Foundation

public actor CloudThumbCache {
  public let baseDir: URL
  public let maxBytes: Int64

  /// Approximate running total of bytes written to the cache. Updated
  /// by `put()` — eviction skips the directory walk entirely until
  /// this counter crosses `maxBytes`. Seeded lazily on the first put
  /// after process start (via `seedTotalIfNeeded`) so a warm cache on
  /// disk doesn't underestimate.
  private var approxTotal: Int64 = 0
  private var seededTotal: Bool = false

  /// In-flight eviction task. While non-nil, additional `put()` calls
  /// just enqueue behind the existing eviction rather than spawning N
  /// concurrent directory walks during a fast scroll.
  private var evictionTask: Task<Void, Never>?

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

  /// Sample cache for SwiftUI `#Preview` blocks. Backed by a per-process
  /// temp directory so previews never collide with the real cache. The
  /// directory is created lazily on first put; this constructor just picks
  /// a unique URL. Issue #139.
  public static func preview() -> CloudThumbCache {
    let tmp = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-preview-\(UUID().uuidString)", isDirectory: true)
    return CloudThumbCache(baseDir: tmp, maxBytes: 64 * 1024 * 1024)
  }

  public func get(host: String, absPath: String) -> Data? {
    let url = path(host: host, absPath: absPath)
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    // Touch mtime so LRU sees the access.
    try? FileManager.default.setAttributes([.modificationDate: Date()],
                                           ofItemAtPath: url.path)
    return try? Data(contentsOf: url)
  }

  public func put(host: String, absPath: String, _ avif: Data) {
    let url = path(host: host, absPath: absPath)
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true)
    try? avif.write(to: url, options: .atomic)
    seedTotalIfNeeded()
    approxTotal += Int64(avif.count)
    // Only schedule eviction when the running total has crossed the
    // cap AND no eviction is already in flight. A scrolling Timeline
    // can fire hundreds of put()s in quick succession; previously each
    // one queued a fresh full-directory walk, hammering disk IO.
    if approxTotal > maxBytes, evictionTask == nil {
      evictionTask = Task { [weak self] in
        await self?.runEviction()
      }
    }
  }

  /// Public for tests — runs the directory walk + LRU pass once,
  /// regardless of the running-total counter. Production code should
  /// rely on the auto-coalesced path triggered from `put()`.
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
    // After a successful walk we know the exact on-disk total — update
    // the running counter so the next `put()` doesn't kick off another
    // walk based on a stale running total.
    approxTotal = total
    seededTotal = true
  }

  /// Seed `approxTotal` from disk on the first put after process start
  /// — without this, a warm cache from a previous launch would
  /// underestimate until the first eviction. Cheap (one directory walk
  /// for sizes only, no sort).
  private func seedTotalIfNeeded() {
    guard !seededTotal else { return }
    seededTotal = true
    let fm = FileManager.default
    guard let enumerator = fm.enumerator(
      at: baseDir,
      includingPropertiesForKeys: [.fileSizeKey],
      options: [.skipsHiddenFiles])
    else { return }
    var total: Int64 = 0
    for case let url as URL in enumerator {
      let v = try? url.resourceValues(forKeys: [.fileSizeKey])
      total += Int64(v?.fileSize ?? 0)
    }
    approxTotal = total
  }

  /// Body of the coalesced eviction Task — runs the walk, then clears
  /// `evictionTask` so a subsequent over-cap put can schedule the next
  /// pass.
  private func runEviction() {
    evictIfNeeded()
    evictionTask = nil
  }

  private func path(host: String, absPath: String) -> URL {
    let digest = SHA256.hash(data: Data(absPath.utf8))
      .map { String(format: "%02x", $0) }.joined()
    return baseDir
      .appendingPathComponent(host, isDirectory: true)
      .appendingPathComponent(String(digest.prefix(2)), isDirectory: true)
      .appendingPathComponent("\(digest).avif")
  }
}
