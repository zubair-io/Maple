// CollisionResolverTests.swift — the shared collision-suffixing algorithm
// (issue #2631), tested in isolation against a simple in-memory `exists`
// predicate — no filesystem or network needed since this is pure string
// math shared by both engines.

import XCTest
@testable import MapleCore

final class CollisionResolverTests: XCTestCase {

    func testReturnsThePathUnchangedWhenFree() async throws {
        let result = try await CollisionResolver.pickFreePath("/a/IMG_1.dng") { _ in false }
        XCTAssertEqual(result, "/a/IMG_1.dng")
    }

    func testAppendsDotNBeforeTheExtension() async throws {
        let occupied: Set<String> = ["/a/IMG_1.dng", "/a/IMG_1.1.dng"]
        let result = try await CollisionResolver.pickFreePath("/a/IMG_1.dng") { occupied.contains($0) }
        XCTAssertEqual(result, "/a/IMG_1.2.dng")
    }

    func testExtensionlessPathGetsABareDotNSuffix() async throws {
        let occupied: Set<String> = ["/a/README"]
        let result = try await CollisionResolver.pickFreePath("/a/README") { occupied.contains($0) }
        XCTAssertEqual(result, "/a/README.1")
    }

    func testThrowsAfterExhaustingAllCandidatesRatherThanReturningAnOccupiedPath() async throws {
        do {
            _ = try await CollisionResolver.pickFreePath("/a/IMG_1.dng") { _ in true }
            XCTFail("expected an error rather than an occupied path")
        } catch {
            // any error is acceptable — the load-bearing property is that it
            // never silently hands back an occupied candidate for a caller
            // to overwrite.
        }
    }
}
