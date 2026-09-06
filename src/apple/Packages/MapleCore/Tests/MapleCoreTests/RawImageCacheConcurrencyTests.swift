import Foundation
import XCTest

@testable import MapleCore

final class RawImageCacheConcurrencyTests: XCTestCase {
  private actor ControlledDecode {
    private var finishes: [CheckedContinuation<Void, Never>] = []
    private var observers: [(Int, CheckedContinuation<Void, Never>)] = []
    private(set) var calls = 0

    func open(_ url: URL) async throws -> MapleRawHandle {
      calls += 1
      let ready = observers.filter { calls >= $0.0 }
      observers.removeAll { calls >= $0.0 }
      for observer in ready { observer.1.resume() }
      await withCheckedContinuation { finishes.append($0) }
      return try PipelineRenderer.openRawHandle(rawPath: url)
    }

    func waitForCalls(_ count: Int) async {
      if calls >= count { return }
      await withCheckedContinuation { observers.append((count, $0)) }
    }

    func finish() { finishes.removeFirst().resume() }
  }

  private func fixtureCopy() throws -> (URL, URL) {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let fixture = root.appendingPathComponent("MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "raw-cache-race")
    let raw = directory.appendingPathComponent("first.dng")
    try FileManager.default.copyItem(at: fixture, to: raw)
    return (directory, raw)
  }

  func testEvictionCannotBeUndoneByPendingDecode() async throws {
    let (directory, raw) = try fixtureCopy()
    defer { try? FileManager.default.removeItem(at: directory) }
    let controlled = ControlledDecode()
    let cache = RawImageCache { try await controlled.open($0) }
    let pending = Task { try await cache.handle(for: raw) }
    await controlled.waitForCalls(1)
    await cache.evict()
    await controlled.finish()
    _ = try await pending.value
    let cachedURL = await cache.cachedURL
    XCTAssertNil(cachedURL, "A late RAW decode must not restore an evicted 30–300 MB handle")
  }

  func testChangedOriginalDoesNotJoinAnOlderDecode() async throws {
    let (directory, raw) = try fixtureCopy()
    defer { try? FileManager.default.removeItem(at: directory) }
    let controlled = ControlledDecode()
    let cache = RawImageCache { try await controlled.open($0) }
    let first = Task { try await cache.handle(for: raw) }
    await controlled.waitForCalls(1)
    // Only the test's copy changes, never a photographer's original.
    try FileManager.default.setAttributes(
      [.modificationDate: Date().addingTimeInterval(100)], ofItemAtPath: raw.path)
    let second = Task { try await cache.handle(for: raw) }
    await controlled.finish()
    _ = try await first.value
    await controlled.waitForCalls(2)
    await controlled.finish()
    let secondHandle = try await second.value
    let cachedHandle = try await cache.handle(for: raw)
    XCTAssertTrue(secondHandle === cachedHandle)
    let calls = await controlled.calls
    XCTAssertEqual(calls, 2, "An in-flight entry is keyed on original mtime as well as URL")
  }

  func testConcurrentTilesReuseTheCompletedHandle() async throws {
    let (directory, raw) = try fixtureCopy()
    defer { try? FileManager.default.removeItem(at: directory) }
    let controlled = ControlledDecode()
    let cache = RawImageCache { try await controlled.open($0) }
    let first = Task { try await cache.handle(for: raw) }
    await controlled.waitForCalls(1)
    let second = Task { try await cache.handle(for: raw) }
    await controlled.finish()
    let a = try await first.value
    let b = try await second.value
    XCTAssertTrue(a === b)
    let calls = await controlled.calls
    XCTAssertEqual(calls, 1)
  }
}
