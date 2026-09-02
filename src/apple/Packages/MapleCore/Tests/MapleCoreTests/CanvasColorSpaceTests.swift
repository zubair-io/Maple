// CanvasColorSpaceTests.swift — the sRGB / Display P3 canvas toggle (#1338).
//
// Save/restore pattern for `UserDefaults.standard` mirrors
// `RenderActorTests.testAmazeFlagDefaultsToEnabled` (AmazeFlag's own
// precedent) — the key is process-global, so every test that touches it
// must leave it exactly as found.

import XCTest
@testable import MapleCore

final class CanvasColorSpaceTests: XCTestCase {
    private func withCleanDefaults(_ body: () -> Void) {
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

    /// With no UserDefaults key written, `current` falls back to the
    /// display-capability default rather than crashing or silently
    /// picking a fixed value — exercised for both outcomes by overriding
    /// what `mainDisplaySupportsP3` reports isn't possible from a unit
    /// test (it reads the real screen), so this asserts the resolvable
    /// invariant instead: the result is always one of the two cases, and
    /// it agrees with a direct call to the same capability check.
    func testUnsetKeyFallsBackToDisplayCapabilityDefault() {
        withCleanDefaults {
            let expected: CanvasColorSpace = CanvasColorSpace.mainDisplaySupportsP3 ? .displayP3 : .srgb
            XCTAssertEqual(CanvasColorSpace.current, expected)
        }
    }

    /// Once the user has touched the Settings picker, the stored value
    /// wins over the display-capability default — even when it disagrees
    /// with what the display would suggest (explicit sRGB on a P3 display,
    /// explicit P3 on a non-P3 display: both are legitimate user choices).
    func testExplicitUserDefaultsValueWinsOverCapabilityDefault() {
        withCleanDefaults {
            UserDefaults.standard.set(CanvasColorSpace.srgb.rawValue, forKey: CanvasColorSpace.defaultsKey)
            XCTAssertEqual(CanvasColorSpace.current, .srgb)

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
            UserDefaults.standard.set(99, forKey: CanvasColorSpace.defaultsKey)
            let expected: CanvasColorSpace = CanvasColorSpace.mainDisplaySupportsP3 ? .displayP3 : .srgb
            XCTAssertEqual(CanvasColorSpace.current, expected)
        }
    }

    /// `current` is read from `GpuLiveSession` — a plain (non-MainActor)
    /// `actor` — on every render tick (#1338 review round on #3192: three
    /// independent passes flagged the pre-fix `UIScreen.main`/`NSScreen.main`
    /// straight-line read as a Main-Thread-Checker crash risk from exactly
    /// this call pattern). Exercise the SAME shape here: call `current` from
    /// a detached, definitely-off-main `Task` and from a background
    /// `DispatchQueue`, both live (not merely "doesn't throw") — a crash or
    /// hang would fail the test outright rather than assert false.
    func testCurrentIsSafeToReadFromABackgroundThread() async {
        withCleanDefaults {
            _ = CanvasColorSpace.current // warm `mainDisplaySupportsP3` before spawning off-main
        }
        let fromTask = await Task.detached { () -> CanvasColorSpace in
            XCTAssertFalse(Thread.isMainThread, "Task.detached must not land on the main thread")
            return CanvasColorSpace.current
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
