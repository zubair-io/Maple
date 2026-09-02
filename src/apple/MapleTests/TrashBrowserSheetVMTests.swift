// TrashBrowserSheetVMTests.swift — #2751.
//
// Pins `TrashBrowserSheetVM.groups(for:)`'s pure grouping/sorting
// derivation. Lives in MapleTests (not MapleCoreTests) because
// `TrashBrowserRow`/`TrashBrowserSheetVM` are app-target types (jules
// review, PR #3178: this logic was originally inline in the SwiftUI view
// itself — pattern #192 requires a sibling `+VM.swift` with no SwiftUI
// import, unit-testable in isolation).

import Foundation
import MapleCore
import XCTest

@testable import Maple_Exposure

final class TrashBrowserSheetVMTests: XCTestCase {

    private func row(id: String, originalRelativePath: String) -> TrashBrowserRow {
        TrashBrowserRow(local: TrashedItem(
            id: id, primaryPath: "/trash/\(id)", sidecarPath: nil,
            originalRelativePath: originalRelativePath, trashedDate: nil, size: 0
        ))
    }

    func testItemsAtTheLibraryRootFormTheRootGroup() {
        let rows = [row(id: "1", originalRelativePath: "IMG_1.dng")]

        let groups = TrashBrowserSheetVM.groups(for: rows)

        XCTAssertEqual(groups.count, 1)
        XCTAssertTrue(groups[0].isRoot)
        XCTAssertEqual(groups[0].id, "")
        XCTAssertEqual(groups[0].rows.map(\.id), ["1"])
    }

    func testItemsUnderTheSameDirectoryShareOneGroup() {
        let rows = [
            row(id: "1", originalRelativePath: "2024/Paris/IMG_1.dng"),
            row(id: "2", originalRelativePath: "2024/Paris/IMG_2.dng"),
        ]

        let groups = TrashBrowserSheetVM.groups(for: rows)

        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].id, "2024/Paris")
        XCTAssertFalse(groups[0].isRoot)
        XCTAssertEqual(Set(groups[0].rows.map(\.id)), ["1", "2"])
    }

    /// The Copilot/jules-flagged ambiguity case: two subfolders with the
    /// SAME last path component under DIFFERENT parents must stay two
    /// distinct groups, keyed by their full relative path.
    func testSameNamedSubfoldersUnderDifferentParentsStayDistinctGroups() {
        let rows = [
            row(id: "1", originalRelativePath: "2023/Paris/IMG_1.dng"),
            row(id: "2", originalRelativePath: "2024/Paris/IMG_2.dng"),
        ]

        let groups = TrashBrowserSheetVM.groups(for: rows)

        XCTAssertEqual(Set(groups.map(\.id)), ["2023/Paris", "2024/Paris"])
        XCTAssertEqual(groups.count, 2)
    }

    func testRootGroupSortsFirstThenSubfoldersAlphabetically() {
        let rows = [
            row(id: "1", originalRelativePath: "banana/IMG_1.dng"),
            row(id: "2", originalRelativePath: "IMG_2.dng"),
            row(id: "3", originalRelativePath: "Apple/IMG_3.dng"),
        ]

        let groups = TrashBrowserSheetVM.groups(for: rows)

        XCTAssertEqual(groups.map(\.id), ["", "Apple", "banana"])
    }

    func testEmptyRowsProduceNoGroups() {
        XCTAssertTrue(TrashBrowserSheetVM.groups(for: []).isEmpty)
    }
}
