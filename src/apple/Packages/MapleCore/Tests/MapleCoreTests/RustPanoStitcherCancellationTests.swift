// RustPanoStitcherCancellationTests.swift — a cancelled FFI run surfaces as
// CancellationError however it was cancelled, while a genuine core failure
// keeps its message.

import XCTest
import os
@testable import MapleCore

final class RustPanoStitcherCancellationTests: XCTestCase {

    private let coreCancelled = PanoStitcherError.stitchFailed(code: -7, message: "cancelled by caller")

    func testStitcherCancelTurnsTheCoreCancelCodeIntoCancellationError() async throws {
        let stitcher = RustPanoStitcher(provisioning: PanoProvisioning(defaults: UserDefaults(suiteName: UUID().uuidString)!))
        let gate = BlockingGate()
        let run = Task { [coreCancelled] in
            try await stitcher.runOffMain(progress: { _, _ in }) { _, _ -> Int in
                gate.waitForRelease()
                throw coreCancelled
            }
        }
        await gate.waitUntilEntered()

        stitcher.cancel()
        gate.release()

        do {
            _ = try await run.value
            XCTFail("a cancelled run returned a value")
        } catch {
            XCTAssertTrue(error is CancellationError, "expected CancellationError, got \(error)")
        }
    }

    func testAFailureNobodyCancelledKeepsItsMessage() async {
        let stitcher = RustPanoStitcher(provisioning: PanoProvisioning(defaults: UserDefaults(suiteName: UUID().uuidString)!))
        do {
            _ = try await stitcher.runOffMain(progress: { _, _ in }) { [coreCancelled] _, _ -> Int in
                throw coreCancelled
            }
            XCTFail("the failing run returned a value")
        } catch PanoStitcherError.stitchFailed(let code, _) {
            XCTAssertEqual(code, -7)
        } catch {
            XCTFail("expected stitchFailed, got \(error)")
        }
    }

    func testCancelReachesEveryRunInFlight() async throws {
        let stitcher = RustPanoStitcher(provisioning: PanoProvisioning(defaults: UserDefaults(suiteName: UUID().uuidString)!))
        let gates = [BlockingGate(), BlockingGate()]
        let runs = gates.map { gate in
            Task { [coreCancelled] in
                try await stitcher.runOffMain(progress: { _, _ in }) { _, _ -> Int in
                    gate.waitForRelease()
                    throw coreCancelled
                }
            }
        }
        for gate in gates { await gate.waitUntilEntered() }

        stitcher.cancel()
        gates.forEach { $0.release() }

        for run in runs {
            do {
                _ = try await run.value
                XCTFail("a cancelled run returned a value")
            } catch {
                XCTAssertTrue(error is CancellationError, "expected CancellationError, got \(error)")
            }
        }
    }
}

/// Holds a detached FFI stand-in until the test releases it.
private final class BlockingGate: Sendable {
    private let entered = OSAllocatedUnfairLock(initialState: false)
    private let released = DispatchSemaphore(value: 0)

    func waitForRelease() {
        entered.withLock { $0 = true }
        released.wait()
    }

    func release() { released.signal() }

    func waitUntilEntered() async {
        while !entered.withLock({ $0 }) { try? await Task.sleep(for: .milliseconds(2)) }
    }
}
