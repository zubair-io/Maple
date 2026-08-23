import XCTest
@testable import MapleUI

/// An injected clock that records every requested delay but never actually
/// sleeps, so these tests run instantly instead of racing `intervalMs`
/// against the real wall clock — same shape as `MuiToastControllerTests`'
/// `FakeClock`.
private actor FakeClock {
    private(set) var requestedDelaysNs: [UInt64] = []

    func sleep(_ ns: UInt64) {
        requestedDelaysNs.append(ns)
    }
}

@MainActor
final class MuiBotOutputControllerTests: XCTestCase {
    func testNonStreamingRevealShowsTheWholeTextImmediately() async {
        let clock = FakeClock()
        let controller = MuiBotOutputController(sleep: { await clock.sleep($0) })

        await controller.reveal(text: "Hello there", streaming: false, charsPerTick: 2, intervalMs: 30, onCompleted: {})

        XCTAssertEqual(controller.visibleLength, "Hello there".count)
        let delays = await clock.requestedDelaysNs
        XCTAssertTrue(delays.isEmpty)
    }

    func testStreamingRevealAdvancesInChunksAndCompletesExactlyOnce() async {
        let clock = FakeClock()
        let controller = MuiBotOutputController(sleep: { await clock.sleep($0) })
        var completedCount = 0

        await controller.reveal(text: "Hello", streaming: true, charsPerTick: 2, intervalMs: 30, onCompleted: { completedCount += 1 })

        XCTAssertEqual(controller.visibleLength, 5)
        XCTAssertEqual(completedCount, 1)
        // "Hello" is 5 chars, revealed 2 at a time: 3 ticks (2, 4, 5).
        let delays = await clock.requestedDelaysNs
        XCTAssertEqual(delays.count, 3)
        XCTAssertEqual(delays.first, 30_000_000)
    }

    func testStreamingRevealResetsVisibleLengthToZeroBeforeTicking() async {
        let clock = FakeClock()
        let controller = MuiBotOutputController(sleep: { await clock.sleep($0) })

        await controller.reveal(text: "Hi", streaming: true, charsPerTick: 10, intervalMs: 10, onCompleted: {})

        // A single tick with a chunk size larger than the text reveals it
        // all in one step, starting from zero.
        XCTAssertEqual(controller.visibleLength, 2)
        let delays = await clock.requestedDelaysNs
        XCTAssertEqual(delays.count, 1)
    }

    func testEmptyTextCompletesWithoutTicking() async {
        let clock = FakeClock()
        let controller = MuiBotOutputController(sleep: { await clock.sleep($0) })
        var completedCount = 0

        await controller.reveal(text: "", streaming: true, charsPerTick: 2, intervalMs: 30, onCompleted: { completedCount += 1 })

        XCTAssertEqual(controller.visibleLength, 0)
        XCTAssertEqual(completedCount, 1)
        let delays = await clock.requestedDelaysNs
        XCTAssertTrue(delays.isEmpty)
    }
}
