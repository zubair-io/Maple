// MapleTestsStub.swift — minimal source so the MapleTests Xcode test
// target produces a non-empty xctest bundle that codesigns cleanly.
// Real unit tests live in
// `src/apple/Packages/MapleCore/Tests/MapleCoreTests/` and run via
// `cd src/apple/Packages/MapleCore && swift test` — see CLAUDE.md
// § "Build & test — Apple". Without this file the .xctest has no
// Swift sources, codesign refuses to sign the empty bundle, and any
// `xcodebuild test` action against the scheme fails before any test
// runs (because Maple.app embeds the unsigned PlugIn).

import XCTest

final class MapleTestsStub: XCTestCase {
    /// Always passes. Exists only so the MapleTests xctest bundle has
    /// at least one Swift symbol to sign.
    func testStub() {
        XCTAssertTrue(true)
    }
}
