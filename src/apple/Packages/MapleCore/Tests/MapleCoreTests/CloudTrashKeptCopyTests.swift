import XCTest
@testable import MapleCore

/// #5419 — the Trash browser's notice for a permanent delete that kept the
/// photo, and the grid check that refreshes the folder now showing it.
final class CloudTrashKeptCopyTests: XCTestCase {
    func testNoticeSaysThePhotoWasKeptRatherThanDeleted() {
        let notice = CloudTrashKeptCopy.notice(filename: "IMG_1.dng", cleanupPending: false)
        XCTAssertEqual(
            notice,
            "Removed the copy of \"IMG_1.dng\" in Trash. The photo was kept because another copy exists.")
        XCTAssertFalse(notice.localizedCaseInsensitiveContains("permanently deleted"))
    }

    func testPendingCleanupIsAGentleNote() {
        XCTAssertTrue(
            CloudTrashKeptCopy.notice(filename: "IMG_1.dng", cleanupPending: true)
                .hasSuffix("kept because another copy exists. Its file cleanup will finish shortly."))
    }

    func testOnlyTheFolderHoldingTheKeptCopyShowsIt() {
        let kept = "/vol/photos/2024/Trip/IMG_1.dng"
        XCTAssertTrue(
            CloudTrashKeptCopy.folderShowsKeptCopy(folderPath: "/vol/photos/2024/Trip", keptAbsPath: kept))
        XCTAssertTrue(
            CloudTrashKeptCopy.folderShowsKeptCopy(folderPath: "/vol/photos/2024/Trip/", keptAbsPath: kept))
        XCTAssertFalse(
            CloudTrashKeptCopy.folderShowsKeptCopy(folderPath: "/vol/photos/2024", keptAbsPath: kept))
        XCTAssertFalse(
            CloudTrashKeptCopy.folderShowsKeptCopy(folderPath: "/vol/photos/2024/Trip", keptAbsPath: nil))
    }
}
