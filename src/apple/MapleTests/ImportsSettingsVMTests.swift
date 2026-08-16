// ImportsSettingsVMTests.swift — unit tests for the pure helpers in
// `Maple/Views/ServerAdmin/ImportsSettingsView+VM.swift`.
//
// Lives in the MapleTests Xcode target (not MapleCore) because
// `ImportsSettingsVM` is declared in the app target, per the `+VM.swift`
// co-location pattern — same as CloudflareSettingsVMTests /
// NetworkSettingsVMTests. The actual business rules this VM renders
// (source-inside-library, blank-label omission) are tested against
// MapleCloudKit directly in MapleCoreTests/ImportsTests.swift; these tests
// only cover the copy and view-facing decisions built on top of them.
//
// Worth knowing when running these locally: the MapleTests target is hosted
// by an app bundle, so `xcodebuild test -only-testing:MapleTests` fails with
// LaunchServices error -10699 while any copy of Maple is running. Quit the
// app first.

import Foundation
import MapleCore
import XCTest

@testable import Maple_Exposure

final class ImportsSettingsVMTests: XCTestCase {

    // MARK: - currentBlocked

    func test_currentBlocked_falseWhenNoListingLoadedYet() {
        XCTAssertFalse(
            ImportsSettingsVM.currentBlocked(listingPath: nil, libraryRoot: "/photos"))
    }

    func test_currentBlocked_falseWhenNoLibraryChosenYet() {
        XCTAssertFalse(
            ImportsSettingsVM.currentBlocked(listingPath: "/photos", libraryRoot: nil))
    }

    func test_currentBlocked_trueInsideTheLibrary() {
        XCTAssertTrue(
            ImportsSettingsVM.currentBlocked(listingPath: "/photos/2026", libraryRoot: "/photos"))
    }

    func test_currentBlocked_falseForAnAncestorOfTheLibrary() {
        // The asymmetric rule this delegates to: `/` (and any other
        // ancestor) must stay usable as a source.
        XCTAssertFalse(ImportsSettingsVM.currentBlocked(listingPath: "/", libraryRoot: "/photos"))
    }

    // MARK: - libraryLabel

    private func library(id: String, label: String, path: String) -> CloudFolder {
        CloudFolder(id: id, path: path, label: label)
    }

    func test_libraryLabel_usesTheMatchingLibrarysDisplayName() {
        let libraries = [library(id: "64a1", label: "Main Library", path: "/photos")]
        XCTAssertEqual(
            ImportsSettingsVM.libraryLabel(libraries: libraries, id: "64a1"), "Main Library")
    }

    func test_libraryLabel_fallsBackToTheRawIDWhenNotFound() {
        XCTAssertEqual(ImportsSettingsVM.libraryLabel(libraries: [], id: "64a1"), "64a1")
    }

    // MARK: - queuedNoticeText

    func test_queuedNoticeText_nilWhenNothingWasQueued() {
        XCTAssertNil(ImportsSettingsVM.queuedNoticeText(nil))
    }

    func test_queuedNoticeText_distinguishesManualFromAuto() {
        let manual = try! XCTUnwrap(ImportsSettingsVM.queuedNoticeText(.manual))
        let auto = try! XCTUnwrap(ImportsSettingsVM.queuedNoticeText(.auto))
        XCTAssertFalse(manual.contains("(auto)"))
        XCTAssertTrue(auto.contains("(auto)"))
    }

    // MARK: - progress step formatting

    private func summary(current: Int, total: Int, copied: Int, skipped: Int, failed: Int)
        -> ImportSummary
    {
        let json = """
            {"id":"1","status":"running","source_root":"/s","library_id":"l",
             "library_root":"/lib","scan_pending":false,
             "progress":{"current":\(current),"total":\(total)},
             "counts":{"copied":\(copied),"skipped":\(skipped),"failed":\(failed)},
             "error":null,"cancel_requested":false,"created_at":"x","updated_at":"x"}
            """
        return try! JSONDecoder().decode(ImportSummary.self, from: Data(json.utf8))
    }

    func test_filesSummaryText_formatsCurrentOverTotal() {
        let text = ImportsSettingsVM.filesSummaryText(
            summary(current: 5, total: 20, copied: 5, skipped: 0, failed: 0))
        XCTAssertEqual(text, "5 / 20 files")
    }

    func test_countsSummaryText_formatsAllThreeCounts() {
        let text = ImportsSettingsVM.countsSummaryText(
            summary(current: 5, total: 20, copied: 4, skipped: 1, failed: 2))
        XCTAssertEqual(text, "4 copied · 1 skipped · 2 failed")
    }

    // MARK: - cancelButtonTitle

    func test_cancelButtonTitle_reflectsWhetherCancelWasRequested() {
        XCTAssertEqual(ImportsSettingsVM.cancelButtonTitle(cancelRequested: false), "Cancel")
        XCTAssertEqual(
            ImportsSettingsVM.cancelButtonTitle(cancelRequested: true), "Cancelling…")
    }

    // MARK: - startsOnProgress (deep link)

    func test_startsOnProgress_trueWhenAJobIDWasSupplied() {
        // Acceptance criterion #6: opening Imports with a job id must land
        // directly on step 3 rather than the picker.
        XCTAssertTrue(ImportsSettingsVM.startsOnProgress(jobID: "64f0"))
    }

    func test_startsOnProgress_falseWithoutAJobID() {
        XCTAssertFalse(ImportsSettingsVM.startsOnProgress(jobID: nil))
    }
}
