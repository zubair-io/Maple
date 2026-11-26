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
  private(set) var approxTotal: Int64 = 0
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

  /// Nonisolated async, so the read runs on the global executor: never on
  /// the caller's main thread, and never behind another cell's write or the
  /// eviction walk (#6017).
  ///
  /// One entry per path. `version` (the server's `thumb_version`) names the
  /// rendering a caller wants: an entry stored under another version, or
  /// under none, is a miss, so an edit made elsewhere is fetched again
  /// rather than served from the old pixels. A caller with no version (the
  /// editor seed, a listing from a server that names none) takes whichever
  /// rendering is stored.
  public nonisolated func get(host: String, absPath: String, version: String? = nil) async -> Data? {
    let url = path(host: host, absPath: absPath)
    guard let file = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { try? file.close() }
    // The version and the bytes are read from the one open file, so a `put`
    // that replaces the entry in between cannot pair old bytes with the new
    // version.
    if let version = Self.storable(version), Self.storedVersion(of: file) != version { return nil }
    guard let data = try? file.readToEnd() else { return nil }
    Self.touchForLRU(url)
    return data
  }

  private static let versionAttribute = "app.justmaple.thumb-version"
  private static let longestStoredVersion = 128

  private nonisolated static func storedVersion(of file: FileHandle) -> String? {
    var buffer = [UInt8](repeating: 0, count: longestStoredVersion)
    let length = fgetxattr(file.fileDescriptor, versionAttribute, &buffer, buffer.count, 0, 0)
    guard length > 0 else { return nil }
    return String(decoding: buffer.prefix(length), as: UTF8.self)
  }

  /// A version the file cannot record would miss on every read and fetch
  /// the thumbnail again each time, so it counts as no version at all.
  private nonisolated static func storable(_ version: String?) -> String? {
    version.flatMap { $0.isEmpty || $0.utf8.count > longestStoredVersion ? nil : $0 }
  }

  private nonisolated static func store(version: String, on url: URL) {
    let bytes = Array(version.utf8)
    _ = setxattr(url.path, versionAttribute, bytes, bytes.count, 0, 0)
  }

  /// The stored thumbnail for `version`, else a fresh fetch stored under it.
  /// When the server cannot be reached, whichever rendering is stored:
  /// offline, an older thumbnail beats a placeholder. Any other failure
  /// stays a miss, so the caller's retry can still bring the new rendering.
  public nonisolated func bytes(
    host: String, absPath: String, version: String?,
    fetch: @Sendable () async throws -> Data
  ) async -> Data? {
    if let cached = await get(host: host, absPath: absPath, version: version) { return cached }
    do {
      let fetched = try await fetch()
      await put(host: host, absPath: absPath, version: version, fetched)
      return fetched
    } catch {
      guard version != nil, Self.isUnreachable(error) else { return nil }
      return await get(host: host, absPath: absPath)
    }
  }

  private nonisolated static func isUnreachable(_ error: Error) -> Bool {
    switch (error as? URLError)?.code {
    case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost,
      .dnsLookupFailed, .timedOut, .dataNotAllowed:
      true
    default: false
    }
  }

  // LRU only needs coarse recency; rewriting the mtime on every hit doubled
  // the metadata I/O of a scroll.
  private nonisolated static func touchForLRU(_ url: URL) {
    let fm = FileManager.default
    let modified = (try? fm.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
    guard let modified, Date().timeIntervalSince(modified) > lruTouchInterval else { return }
    try? fm.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
  }

  static let lruTouchInterval: TimeInterval = 60 * 60

  public nonisolated func put(
    host: String, absPath: String, version: String? = nil, _ avif: Data
  ) async {
    let url = path(host: host, absPath: absPath)
    let fm = FileManager.default
    try? fm.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true)
    // Staged beside the entry and renamed over it, so the version is already
    // on the file when a reader first sees the new bytes.
    let staged = url.appendingPathExtension("\(UUID().uuidString).part")
    guard (try? avif.write(to: staged)) != nil else {
      try? fm.removeItem(at: staged)
      return
    }
    if let version = Self.storable(version) { Self.store(version: version, on: staged) }
    // A replaced entry frees its own bytes; counting the whole write would
    // push the running total past the cap with the disk nowhere near it.
    let replaced = ((try? fm.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.int64Value
    guard rename(staged.path, url.path) == 0 else {
      try? fm.removeItem(at: staged)
      return
    }
    await account(writtenBytes: Int64(avif.count) - (replaced ?? 0))
  }

  private func account(writtenBytes: Int64) {
    seedTotalIfNeeded()
    approxTotal += writtenBytes
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
    // The walk just measured the cache, so the running total takes its
    // answer even when nothing needs evicting; otherwise a total that
    // drifted past the cap would start a walk on every put.
    approxTotal = total
    seededTotal = true
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
  /// underestimate until the first eviction. The walk covers up to the
  /// whole 2 GB cache, so it runs detached and adds its total when done
  /// rather than holding every get/put behind it (#6017).
  private func seedTotalIfNeeded() {
    guard !seededTotal else { return }
    seededTotal = true
    let baseDir = baseDir
    Task.detached(priority: .utility) { [weak self] in
      let total = Self.onDiskTotal(of: baseDir)
      await self?.addSeededTotal(total)
    }
  }

  private func addSeededTotal(_ total: Int64) {
    approxTotal += total
    if approxTotal > maxBytes, evictionTask == nil {
      evictionTask = Task { [weak self] in
        await self?.runEviction()
      }
    }
  }

  private nonisolated static func onDiskTotal(of baseDir: URL) -> Int64 {
    guard let enumerator = FileManager.default.enumerator(
      at: baseDir,
      includingPropertiesForKeys: [.fileSizeKey],
      options: [.skipsHiddenFiles])
    else { return 0 }
    var total: Int64 = 0
    for case let url as URL in enumerator {
      let v = try? url.resourceValues(forKeys: [.fileSizeKey])
      total += Int64(v?.fileSize ?? 0)
    }
    return total
  }

  /// Body of the coalesced eviction Task — runs the walk, then clears
  /// `evictionTask` so a subsequent over-cap put can schedule the next
  /// pass.
  private func runEviction() {
    evictIfNeeded()
    evictionTask = nil
  }

  private nonisolated func path(host: String, absPath: String) -> URL {
    let digest = SHA256.hash(data: Data(absPath.utf8))
      .map { String(format: "%02x", $0) }.joined()
    return baseDir
      .appendingPathComponent(host, isDirectory: true)
      .appendingPathComponent(String(digest.prefix(2)), isDirectory: true)
      .appendingPathComponent("\(digest).avif")
  }
}
