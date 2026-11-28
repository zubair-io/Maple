import XCTest

@testable import MapleCore

private protocol BytesTier {
  mutating func lookup(_ key: Int) -> Bool
  mutating func insert(_ key: Int)
}

// The eviction used before #6037: drop whatever the dictionary yields first; a hit changes nothing.
private struct ArbitraryEvictionTier: BytesTier {
  let capacity: Int
  private var entries: [String: Bool] = [:]

  init(capacity: Int) { self.capacity = capacity }

  mutating func lookup(_ key: Int) -> Bool { entries[Self.hashed(key)] != nil }

  mutating func insert(_ key: Int) {
    if entries.count >= capacity, let victim = entries.keys.first {
      entries.removeValue(forKey: victim)
    }
    entries[Self.hashed(key)] = true
  }

  private static func hashed(_ cell: Int) -> String {
    MapleThumbCacheKey.sha256Prefix16(String(cell))
  }
}

private struct LeastRecentlyUsedTier: BytesTier {
  private var store: RecencyOrderedStore<String, Bool>

  init(capacity: Int) { store = RecencyOrderedStore(capacity: capacity) }

  mutating func lookup(_ key: Int) -> Bool {
    store.touch(MapleThumbCacheKey.sha256Prefix16(String(key))) != nil
  }

  mutating func insert(_ key: Int) {
    store.set(true, for: MapleThumbCacheKey.sha256Prefix16(String(key)))
  }
}

// Ordered eviction without the refresh on read, to show what the refresh itself is worth.
private struct FirstInFirstOutTier: BytesTier {
  private var store: RecencyOrderedStore<String, Bool>

  init(capacity: Int) { store = RecencyOrderedStore(capacity: capacity) }

  func lookup(_ key: Int) -> Bool {
    store.peek(MapleThumbCacheKey.sha256Prefix16(String(key))) != nil
  }

  mutating func insert(_ key: Int) {
    store.set(true, for: MapleThumbCacheKey.sha256Prefix16(String(key)))
  }
}

private struct ReplayResult {
  var hits = 0
  var diskReads = 0

  var hitRate: Double { Double(hits) / Double(max(1, hits + diskReads)) }
}

private struct GridTrace {
  static let columns = 8
  static let visibleRows = 6

  let name: String
  let accesses: [Int]
  let measuredFrom: Int

  static func cells(inRow row: Int) -> [Int] { (0..<columns).map { row * columns + $0 } }

  static func scrollDown(rows: Int) -> [Int] {
    (0..<rows).flatMap { cells(inRow: $0 + visibleRows - 1) }
  }

  static func scrollUp(from topRow: Int, rows: Int) -> [Int] {
    (1...rows).flatMap { cells(inRow: topRow - $0) }
  }
}

private func traces() -> [GridTrace] {
  let downRows = 190
  let down = GridTrace.scrollDown(rows: downRows)
  let topRow = downRows
  let backShort = GridTrace.scrollUp(from: topRow, rows: 40)
  let backLong = GridTrace.scrollUp(from: topRow, rows: 100)

  let drift: [Int] = (0..<60).flatMap { cycle -> [Int] in
    let top = topRow + cycle * 2
    let advance = GridTrace.scrollDown(rows: 2).map { $0 + top * GridTrace.columns }
    let jitter = (0..<4).flatMap { _ in
      GridTrace.scrollUp(from: top + 2, rows: 3)
        + (0..<3).flatMap { GridTrace.cells(inRow: top - 1 + $0 + GridTrace.visibleRows) }
    }
    return advance + jitter
  }

  return [
    GridTrace(name: "scroll back 40 rows", accesses: down + backShort, measuredFrom: down.count),
    GridTrace(name: "scroll back 100 rows", accesses: down + backLong, measuredFrom: down.count),
    GridTrace(name: "drift with 3-row jitter", accesses: down + drift, measuredFrom: down.count),
  ]
}

private func replay<Tier: BytesTier>(_ trace: GridTrace, on tier: inout Tier) -> ReplayResult {
  trace.accesses.enumerated().reduce(into: ReplayResult()) { result, access in
    let hit = tier.lookup(access.element)
    if !hit { tier.insert(access.element) }
    guard access.offset >= trace.measuredFrom else { return }
    if hit { result.hits += 1 } else { result.diskReads += 1 }
  }
}

final class ThumbnailBytesTierTraceTests: XCTestCase {
  private let capacity = 600

  func testLeastRecentlyUsedBeatsArbitraryEvictionOnScrollBackTraces() {
    for trace in traces() {
      var arbitrary = ArbitraryEvictionTier(capacity: capacity)
      var recent = LeastRecentlyUsedTier(capacity: capacity)
      let before = replay(trace, on: &arbitrary)
      let after = replay(trace, on: &recent)
      let line = String(
        format:
          "TIER-TRACE %@: before %d hits / %d reads (%.1f%%), after %d hits / %d reads (%.1f%%)",
        trace.name, before.hits, before.diskReads, before.hitRate * 100,
        after.hits, after.diskReads, after.hitRate * 100)
      FileHandle.standardError.write(Data((line + "\n").utf8))
      XCTAssertGreaterThan(after.hitRate, before.hitRate, trace.name)
    }
  }

  func testLeastRecentlyUsedHitsEveryCellWithinCapacityOnScrollBack() {
    let trace = traces()[0]
    var recent = LeastRecentlyUsedTier(capacity: capacity)
    let result = replay(trace, on: &recent)
    XCTAssertEqual(result.diskReads, 0)
    XCTAssertEqual(result.hits, 40 * GridTrace.columns)
  }

  func testLeastRecentlyUsedServesExactlyTheRetainedWindowWhenScrollBackExceedsCapacity() {
    let trace = traces()[1]
    var recent = LeastRecentlyUsedTier(capacity: capacity)
    let result = replay(trace, on: &recent)
    let reachable = capacity - (GridTrace.visibleRows - 1) * GridTrace.columns
    XCTAssertEqual(result.hits, reachable)
    XCTAssertEqual(result.diskReads, 100 * GridTrace.columns - reachable)
  }

  func testARowThatKeepsBeingReadSurvivesAScrollPastTheCapacity() {
    let pinned = GridTrace.cells(inRow: 0)
    let passingRows = 100
    let passing = (1...passingRows).flatMap { GridTrace.cells(inRow: $0) + pinned }
    let trace = GridTrace(
      name: "pinned row", accesses: pinned + passing, measuredFrom: pinned.count)
    var recent = LeastRecentlyUsedTier(capacity: capacity)
    var firstIn = FirstInFirstOutTier(capacity: capacity)

    let refreshed = replay(trace, on: &recent)
    let unrefreshed = replay(trace, on: &firstIn)

    XCTAssertEqual(refreshed.hits, passingRows * pinned.count, "every return to the row is a hit")
    XCTAssertEqual(refreshed.diskReads, passingRows * GridTrace.columns)
    XCTAssertEqual(
      unrefreshed.hits, refreshed.hits - pinned.count,
      "without the refresh on read the row ages out once and is read from disk again")
  }

  func testProvingAnEntryDecodesDoesNotMakeItRecent() async throws {
    let fixture = try CacheFixture()
    defer { fixture.remove() }
    let cache = ThumbnailDiskCache()
    for index in 0..<capacity {
      await cache.storeThumbnailData(fixture.bytes, for: try fixture.asset(index))
    }
    try fixture.dropDiskCopies(of: [0])

    let oldest = await cache.cachedThumbnail(for: try fixture.asset(0))
    for index in 1..<capacity { _ = await cache.cachedThumbnail(for: try fixture.asset(index)) }
    await cache.markDecodable(try XCTUnwrap(oldest))

    await cache.storeThumbnailData(fixture.bytes, for: try fixture.asset(capacity))
    let reread = await cache.cachedThumbnail(for: try fixture.asset(0))
    XCTAssertNil(reread, "the proven entry was still the oldest, so it went first")
  }

  func testMemoryPressureDropsTheOldestEntriesFirst() async throws {
    let fixture = try CacheFixture()
    defer { fixture.remove() }
    let cache = ThumbnailDiskCache()
    for index in 0..<capacity {
      await cache.storeThumbnailData(fixture.bytes, for: try fixture.asset(index))
    }
    try fixture.dropDiskCopies(of: [0, 300])

    let old = await cache.cachedThumbnail(for: try fixture.asset(300))
    await cache.markDecodable(try XCTUnwrap(old))
    for index in 0..<capacity where index != 300 {
      _ = await cache.cachedThumbnail(for: try fixture.asset(index))
    }
    let recent = await cache.cachedThumbnail(for: try fixture.asset(0))
    await cache.markDecodable(try XCTUnwrap(recent))

    await cache.shrinkMemCache(to: 25)

    let keptRecent = await cache.cachedThumbnail(for: try fixture.asset(0))
    let droppedOld = await cache.cachedThumbnail(for: try fixture.asset(300))
    XCTAssertEqual(keptRecent?.isKnownDecodable, true, "the newest quarter stays in memory")
    XCTAssertNil(droppedOld, "the oldest entries are the ones dropped")
  }

  func testCacheKeepsAnEntryThatWasReadRecentlyWhenTheTierFills() async throws {
    let fixture = try CacheFixture()
    defer { fixture.remove() }
    let cache = ThumbnailDiskCache()

    for index in 0..<600 {
      await cache.storeThumbnailData(fixture.bytes, for: try fixture.asset(index))
    }
    try fixture.dropDiskCopies(of: [0, 1])
    let firstHit = await cache.cachedThumbnail(for: try fixture.asset(1))
    await cache.markDecodable(try XCTUnwrap(firstHit))
    let secondHit = await cache.cachedThumbnail(for: try fixture.asset(0))
    await cache.markDecodable(try XCTUnwrap(secondHit))
    _ = await cache.cachedThumbnail(for: try fixture.asset(0))

    for index in 600..<1198 {
      await cache.storeThumbnailData(fixture.bytes, for: try fixture.asset(index))
    }
    let stillProven = await cache.cachedThumbnail(for: try fixture.asset(0))
    XCTAssertEqual(stillProven?.isKnownDecodable, true, "a recently read entry survives")

    await cache.storeThumbnailData(fixture.bytes, for: try fixture.asset(1198))
    let evicted = await cache.cachedThumbnail(for: try fixture.asset(1))
    XCTAssertNil(evicted, "the least recently used entry goes first")
  }
}

private struct CacheFixture {
  let folder: URL
  let bytes = Data([0xFF, 0xD8, 0x01])

  init() throws {
    folder = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-bytes-tier-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  }

  func asset(_ index: Int) throws -> URL {
    let url = folder.appendingPathComponent("cell-\(index).jpg")
    if !FileManager.default.fileExists(atPath: url.path) { try Data([1]).write(to: url) }
    return url
  }

  // A self-written thumb re-reads as decodable, so only a missing disk copy proves eviction.
  func dropDiskCopies(of indices: [Int]) throws {
    for index in indices {
      try FileManager.default.removeItem(at: MapleSidecarPaths.thumbURL(for: try asset(index)))
    }
  }

  func remove() { try? FileManager.default.removeItem(at: folder) }
}
