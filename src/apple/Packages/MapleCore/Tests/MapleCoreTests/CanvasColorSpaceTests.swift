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
}
