// URLPathHierarchyTests.swift — #2649: the path-hierarchy helpers that back
// DropMountPlanner's "already mounted" and "common parent" logic.

import XCTest
@testable import MapleCore

final class URLPathHierarchyTests: XCTestCase {

    // MARK: - isDescendant(ofOrEqualTo:)

    func testIsDescendantTrueForDirectChild() {
        let parent = URL(fileURLWithPath: "/Users/x/Photos")
        let child = URL(fileURLWithPath: "/Users/x/Photos/a.dng")
        XCTAssertTrue(child.isDescendant(ofOrEqualTo: parent))
    }

    func testIsDescendantTrueForDeeplyNestedChild() {
        let parent = URL(fileURLWithPath: "/Users/x/Photos")
        let child = URL(fileURLWithPath: "/Users/x/Photos/2026/08/a.dng")
        XCTAssertTrue(child.isDescendant(ofOrEqualTo: parent))
    }

    func testIsDescendantTrueForSelf() {
        let url = URL(fileURLWithPath: "/Users/x/Photos")
        XCTAssertTrue(url.isDescendant(ofOrEqualTo: url))
    }

    func testIsDescendantFalseForSiblingSharingPrefix() {
        let parent = URL(fileURLWithPath: "/Users/x/Photos")
        let sibling = URL(fileURLWithPath: "/Users/x/PhotosOld/a.dng")
        XCTAssertFalse(sibling.isDescendant(ofOrEqualTo: parent))
    }

    func testIsDescendantFalseForUnrelatedPath() {
        let parent = URL(fileURLWithPath: "/Users/x/Photos")
        let other = URL(fileURLWithPath: "/Users/y/Documents/a.dng")
        XCTAssertFalse(other.isDescendant(ofOrEqualTo: parent))
    }

    func testIsDescendantFalseForParentOfParent() {
        let parent = URL(fileURLWithPath: "/Users/x/Photos")
        let ancestor = URL(fileURLWithPath: "/Users/x")
        XCTAssertFalse(ancestor.isDescendant(ofOrEqualTo: parent))
    }

    // MARK: - commonParent(of:)

    func testCommonParentOfSingleFileIsItsDirectory() {
        let file = URL(fileURLWithPath: "/Users/x/Photos/a.dng")
        XCTAssertEqual(URL.commonParent(of: [file]), URL(fileURLWithPath: "/Users/x/Photos"))
    }

    func testCommonParentOfSiblingFiles() {
        let a = URL(fileURLWithPath: "/Users/x/Photos/a.dng")
        let b = URL(fileURLWithPath: "/Users/x/Photos/b.dng")
        XCTAssertEqual(URL.commonParent(of: [a, b]), URL(fileURLWithPath: "/Users/x/Photos"))
    }

    func testCommonParentOfDeeplyDivergentFiles() {
        let a = URL(fileURLWithPath: "/Users/x/Trip/Day1/a.dng")
        let b = URL(fileURLWithPath: "/Users/x/Trip/Day2/b.dng")
        XCTAssertEqual(URL.commonParent(of: [a, b]), URL(fileURLWithPath: "/Users/x/Trip"))
    }

    func testCommonParentOfCompletelyUnrelatedFilesIsRoot() {
        let a = URL(fileURLWithPath: "/Users/x/a.dng")
        let b = URL(fileURLWithPath: "/Volumes/External/b.dng")
        XCTAssertEqual(URL.commonParent(of: [a, b]), URL(fileURLWithPath: "/"))
    }

    func testCommonParentOfEmptyListIsNil() {
        XCTAssertNil(URL.commonParent(of: []))
    }

    func testCommonParentIncludesFolderItemsOwnPathNotOneLevelUp() {
        // A dropped FOLDER counts by its own path, not the folder above it —
        // dropping "/Users/x/Trip/Day1" alongside a loose file in "Day2"
        // should still land the mount at "/Users/x/Trip", not "/Users/x".
        let folder = URL(fileURLWithPath: "/Users/x/Trip/Day1", isDirectory: true)
        let file = URL(fileURLWithPath: "/Users/x/Trip/Day2/b.dng")
        XCTAssertEqual(URL.commonParent(of: [folder, file]), URL(fileURLWithPath: "/Users/x/Trip"))
    }
}
