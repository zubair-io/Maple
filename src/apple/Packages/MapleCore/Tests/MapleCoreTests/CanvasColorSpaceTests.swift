// CanvasColorSpaceTests.swift — the sRGB / Display P3 canvas toggle (#1338).
//
// Save/restore pattern for `UserDefaults.standard` mirrors
// `RenderActorTests.testAmazeFlagDefaultsToEnabled` (AmazeFlag's own
// precedent) — the key is process-global, so every test that touches it
// must leave it exactly as found. `stateLock` additionally serializes the
// whole save/mutate/restore section against other tests in this file (jules
// review on #3192: an unserialized process-global mutation is a real
// flakiness risk if the runner ever executes tests in parallel).

import XCTest
@testable import MapleCore

final class CanvasColorSpaceTests: XCTestCase {
    private static let stateLock = NSLock()

    private func withCleanDefaults(_ body: () -> Void) {
        Self.stateLock.lock()
        defer { Self.stateLock.unlock() }
        let saved = UserDefaults.standard.object(forKey: CanvasColorSpace.defaultsKey)
        UserDefaults.standard.removeObject(forKey: CanvasColorSpace.defaultsKey)
        defer {
            if let saved {
                UserDefaults.standard.set(saved, forKey: CanvasColorSpace.defaultsKey)
            } else {
                UserDefaults.standard.removeObject(forKey: CanvasColorSpace.defaultsKey)
            }
        }
        body()
    }

    /// Wire values must match the FFI's `target_primaries` encoding
    /// (`raw_core::view::encode::TargetPrimaries::from_u32`): 0 = sRGB,
    /// 1 = P3. A drift here would silently mismatch what the Rust side
    /// decodes.
    func testWireValuesMatchFFIEncoding() {
        XCTAssertEqual(CanvasColorSpace.srgb.wireValue, 0)
        XCTAssertEqual(CanvasColorSpace.displayP3.wireValue, 1)
    }

    /// With no UserDefaults key written, `current` falls back to the cached
    /// display-capability flag — exercised deterministically in BOTH
    /// directions via the `setMainDisplaySupportsP3ForTests` seam rather
    /// than depending on (or being flaky against) whatever the test host's
    /// real screen reports.
    func testUnsetKeyFallsBackToDisplayCapabilityDefault() {
        withCleanDefaults {
            CanvasColorSpace.setMainDisplaySupportsP3ForTests(true)
            XCTAssertEqual(CanvasColorSpace.current, .displayP3)

            CanvasColorSpace.setMainDisplaySupportsP3ForTests(false)
            XCTAssertEqual(CanvasColorSpace.current, .srgb)
        }
    }

    /// Once the user has touched the Settings picker, the stored value
    /// wins over the display-capability default — even when it disagrees
    /// with what the display would suggest (explicit sRGB on a P3 display,
    /// explicit P3 on a non-P3 display: both are legitimate user choices).
    func testExplicitUserDefaultsValueWinsOverCapabilityDefault() {
        withCleanDefaults {
            CanvasColorSpace.setMainDisplaySupportsP3ForTests(true)
            UserDefaults.standard.set(CanvasColorSpace.srgb.rawValue, forKey: CanvasColorSpace.defaultsKey)
            XCTAssertEqual(CanvasColorSpace.current, .srgb)

            CanvasColorSpace.setMainDisplaySupportsP3ForTests(false)
            UserDefaults.standard.set(CanvasColorSpace.displayP3.rawValue, forKey: CanvasColorSpace.defaultsKey)
            XCTAssertEqual(CanvasColorSpace.current, .displayP3)
        }
    }

    /// `current` re-reads UserDefaults on every call (mirrors
    /// `AmazeFlag.isEnabled`) — flipping the Settings picker must take
    /// effect on the very next read, with no caching to invalidate and no
    /// app restart.
    func testCurrentReEvaluatesOnEveryCallNoCaching() {
        withCleanDefaults {
            UserDefaults.standard.set(CanvasColorSpace.srgb.rawValue, forKey: CanvasColorSpace.defaultsKey)
            XCTAssertEqual(CanvasColorSpace.current, .srgb)
            UserDefaults.standard.set(CanvasColorSpace.displayP3.rawValue, forKey: CanvasColorSpace.defaultsKey)
            XCTAssertEqual(
                CanvasColorSpace.current, .displayP3,
                "current must reflect the NEW value immediately, not a stale read")
        }
    }

    /// An out-of-range stored integer (corrupted defaults, a future enum
    /// case removed) must not crash `Int(rawValue:)` — it falls back to
    /// the display-capability default rather than trapping.
    func testOutOfRangeStoredValueFallsBackSafely() {
        withCleanDefaults {
            CanvasColorSpace.setMainDisplaySupportsP3ForTests(true)
            UserDefaults.standard.set(99, forKey: CanvasColorSpace.defaultsKey)
            XCTAssertEqual(CanvasColorSpace.current, .displayP3)
        }
    }

    /// `current` is read from `GpuLiveSession` — a plain (non-MainActor)
    /// `actor` — on every render tick (#1338 review round on #3192: three
    /// independent passes flagged the pre-fix `UIScreen.main`/`NSScreen.main`
    /// straight-line read as a Main-Thread-Checker crash risk from exactly
    /// this call pattern; a follow-up pass then caught the FIRST fix's own
    /// `DispatchQueue.main.sync`-inside-a-lazy-static-let as a deadlock
    /// risk). Exercise the SAME call shape here — a background `Task
    /// .detached` and a background `DispatchQueue` — as a live smoke test
    /// (crash/hang fails outright) now that `current` never touches
    /// `UIScreen`/`NSScreen` or any lock on its read path at all.
    ///
    /// Does NOT assert `Thread.isMainThread` inside the detached task —
    /// `Task.detached` is documented as not inheriting the caller's actor,
    /// which is NOT a guarantee it runs off the main thread (Copilot review
    /// on #3192); the `DispatchQueue.global` half below is the one that's
    /// unconditionally off-main.
    func testCurrentIsSafeToReadFromABackgroundThread() async {
        let fromTask = await Task.detached { () -> CanvasColorSpace in
            CanvasColorSpace.current
        }.value
        XCTAssertTrue(CanvasColorSpace.allCases.contains(fromTask))

        // A checked continuation (not a shared `var` + XCTestExpectation) so
        // the background write and the `await`ed read have no unsynchronized
        // shared mutable state for the compiler to flag as a race (Copilot
        // review on #3192) — the value crosses threads through the
        // continuation's own internal synchronization instead.
        let fromQueue: CanvasColorSpace = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: CanvasColorSpace.current)
            }
        }
        XCTAssertTrue(CanvasColorSpace.allCases.contains(fromQueue))
    }
}
