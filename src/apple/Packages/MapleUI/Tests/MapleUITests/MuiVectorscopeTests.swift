import XCTest
@testable import MapleUI

final class MuiVectorscopeTests: XCTestCase {
    /// Compile-level regression check, not a pixel check — `Canvas` drawing
    /// isn't unit-testable. Pins that every pre-#3276 call site (bare
    /// `samples:`) still compiles unchanged alongside the new v2 params.
    func testMuiVectorscopeAcceptsTheNewOptionalParametersWithBackwardCompatibleDefaults() {
        let legacy = MuiVectorscope(samples: [])
        XCTAssertNotNil(legacy)
        let v2 = MuiVectorscope(
            samples: [],
            bins: [[UInt32]](repeating: [UInt32](repeating: 0, count: 128), count: 128),
            showSkinToneLine: true,
            redAt3OClock: true
        )
        XCTAssertNotNil(v2)
    }
}
