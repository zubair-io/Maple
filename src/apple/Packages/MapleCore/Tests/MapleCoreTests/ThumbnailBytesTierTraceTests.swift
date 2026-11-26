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

  func testCacheKeepsAnEntryThatWasReadRecentlyWhenTheTierFills() async throws {
    let folder = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-bytes-tier-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }

    let cache = ThumbnailDiskCache()
    let bytes = Data([0xFF, 0xD8, 0x01])
    func asset(_ index: Int) throws -> URL {
      let url = folder.appendingPathComponent("cell-\(index).jpg")
      if !FileManager.default.fileExists(atPath: url.path) { try Data([1]).write(to: url) }
      return url
    }

    for index in 0..<600 { await cache.storeThumbnailData(bytes, for: try asset(index)) }
    let firstHit = await cache.cachedThumbnail(for: try asset(1))
    await cache.markDecodable(try XCTUnwrap(firstHit))
    let secondHit = await cache.cachedThumbnail(for: try asset(0))
    await cache.markDecodable(try XCTUnwrap(secondHit))
    _ = await cache.cachedThumbnail(for: try asset(0))

    for index in 600..<1198 { await cache.storeThumbnailData(bytes, for: try asset(index)) }
    let stillProven = await cache.cachedThumbnail(for: try asset(0))
    XCTAssertEqual(stillProven?.isKnownDecodable, true, "a recently read entry survives")

    await cache.storeThumbnailData(bytes, for: try asset(1198))
    let evicted = await cache.cachedThumbnail(for: try asset(1))
    XCTAssertEqual(evicted?.isKnownDecodable, false, "the least recently used entry goes first")
  }
}
