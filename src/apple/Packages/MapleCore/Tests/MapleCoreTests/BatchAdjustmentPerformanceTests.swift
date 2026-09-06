import Darwin
import XCTest

@testable import MapleCore

final class BatchAdjustmentPerformanceTests: XCTestCase {
  func testTwoThousandActualSidecarWritesRemainBounded() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "batch-2000")
    defer { try? FileManager.default.removeItem(at: root) }
    let reference = root.appendingPathComponent("reference.png")
    let original = try SidecarContractIO.makeSyntheticOriginal(at: reference)
    let targets = try (0..<2000).map { index in
      let url = root.appendingPathComponent("photo-\(index).png")
      try original.write(to: url)
      return BatchAdjustmentTarget(id: url.absoluteString, name: url.lastPathComponent, url: url)
    }
    let ledger = BatchAdjustmentTransfer(directory: root.appendingPathComponent("ledger"))
    var source = AdjustmentModel.default
    source.exposure = 0.75
    source.vibrance = 18
    let request = BatchAdjustmentRequest(
      source: source, groups: [.tone, .color], relativeWhiteBalance: false, sourceBaseline: nil)
    let operation = try await ledger.create(scopeID: "library", request: request, targets: targets)
    var startUsage = rusage()
    getrusage(RUSAGE_SELF, &startUsage)
    let start = ContinuousClock.now
    let result = try await ledger.run(
      operation.id, scopeID: "library",
      prepare: { target, request in
        let (before, _) = try await XMPSidecarStore(rawURL: XCTUnwrap(target.url)).load()
        return PreparedAdjustmentTransfer(
          model: request.source, groupIDs: request.groupIDs, before: before)
      },
      apply: { target, patch in
        let store = XMPSidecarStore(rawURL: try XCTUnwrap(target.url))
        let (current, culling) = try await store.load()
        try patch.validate(current: current)
        try await store.writeConfirmed(model: patch.applying(to: current), culling: culling)
      }, progress: { _ in })
    let elapsed = start.duration(to: .now)
    var endUsage = rusage()
    getrusage(RUSAGE_SELF, &endUsage)
    let seconds = Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
    let growth = max(0, endUsage.ru_maxrss - startUsage.ru_maxrss)
    print(
      "APPLE_BATCH_2000 seconds=\(seconds) photos_per_second=\(2000 / seconds) extra_peak_rss_bytes=\(growth)"
    )
    XCTAssertEqual(result.summary.applied.count, 2000)
    XCTAssertTrue(result.summary.failed.isEmpty)
    XCTAssertLessThan(growth, 256 * 1024 * 1024)
    for target in targets {
      let url = try XCTUnwrap(target.url)
      XCTAssertEqual(try Data(contentsOf: url), original)
      let (model, _) = try await XMPSidecarStore(rawURL: url).load()
      XCTAssertEqual(model.exposure, 0.75)
      XCTAssertEqual(model.vibrance, 18)
    }
  }
}
