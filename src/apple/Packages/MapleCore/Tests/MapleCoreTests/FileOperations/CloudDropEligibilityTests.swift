// CloudDropEligibilityTests.swift — #2725: a same-server, different-library
// Cloud drop must be refused BEFORE any relocate request goes out, since
// `POST /api/assets/:id/relocate` resolves `destination_path` against the
// asset's OWN library and has no way to express a cross-library move.

import XCTest
@testable import MapleCore

final class CloudDropEligibilityTests: XCTestCase {
    func testSameLibraryIsEligible() {
        XCTAssertTrue(
            CloudDropEligibility.isSameLibrary(
                assetLibraryFolderID: "lib-1", destinationLibraryFolderID: "lib-1"))
    }

    func testDifferentLibraryOnTheSameServerIsRefused() {
        XCTAssertFalse(
            CloudDropEligibility.isSameLibrary(
                assetLibraryFolderID: "lib-1", destinationLibraryFolderID: "lib-2"))
    }
}
