// PanoOrtSelftestUITests.swift — iOS Simulator ORT static-link smoke test (M6 #1244).
//
// Proves ONNX Runtime initializes on iOS (not just links). This is the M6-E
// smoke gate: linking the xcframework guarantees the symbol is present; THIS test
// proves ort::init() succeeds — i.e. the statically-linked ORT runtime is
// actually reachable and can initialize its global environment.
//
// Gate: iOS only. `maple_pano_ort_selftest` is declared in RawPipeline.h only
// when `TARGET_OS_IOS` is defined (cbindgen.toml "target_os = ios" mapping).
// This test compiles and runs on the arm64 iOS Simulator (which is native on
// M-series Macs). macOS builds compile past this file (it is in the UITest
// target, which compiles for all platforms) but skip the #if body.
//
// Run:
//   xcodebuild test \
//     -project src/apple/Maple.xcodeproj \
//     -scheme "Maple Exposure" \
//     -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
//     -only-testing:MapleUITests/PanoOrtSelftestUITests/testOrtInitializesOniOS
//
// Success: `maple_pano_ort_selftest()` returns 0 (ORT initialized OK).
// Failure: non-zero return with error detail in `maple_last_error()`.
//
// A full stitch is NOT attempted — models are not provisioned in CI and the
// sim is CPU-only (6-minute stitch is impractical). ORT init is sufficient
// proof that the static link works at runtime.
//
// Ticket: #1244 (M6 — iOS ORT static-link), epic #1234.

import XCTest
import RawPipeline

final class PanoOrtSelftestUITests: XCTestCase {

    /// Verify `maple_pano_ort_selftest()` returns 0 on iOS Simulator (M6 #1244).
    ///
    /// This is a pure FFI call — no app launch, no fixtures.
    func testOrtInitializesOniOS() throws {
        // Swift uses `#if os(iOS)`, not the C preprocessor `TARGET_OS_IOS`.
        // On iOS and iOS Simulator this calls the real FFI; on macOS it skips.
#if os(iOS)
        let rc = maple_pano_ort_selftest()
        if rc != 0 {
            let errPtr = maple_last_error()
            let detail = errPtr.map { String(cString: $0) } ?? "(no error string)"
            XCTFail(
                "maple_pano_ort_selftest() returned \(rc) — ORT did not initialize: \(detail)"
            )
        }
        // rc == 0: ORT initialized successfully on the iOS Simulator.
        // The static-linked onnxruntime is reachable and its global environment
        // committed. This is the M6-E runtime gate.
        XCTAssertEqual(rc, 0, "ORT static init must succeed on iOS Simulator")
#else
        // Not an iOS target — skip. This is expected on macOS and is not a failure.
        throw XCTSkip("maple_pano_ort_selftest is iOS-only (M6 #1244)")
#endif
    }
}
