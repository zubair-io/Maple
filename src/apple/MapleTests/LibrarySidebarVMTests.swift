// LibrarySidebarVMTests.swift — unit tests for the pure helpers in
// `Maple/Views/LibrarySidebar+VM.swift`.
//
// Lives in the MapleTests Xcode target (not MapleCore) because
// `LibrarySidebarVM` is declared in the app target, per the `+VM.swift`
// co-location pattern.
//
// Focus: the #2925 hiding rule, and specifically its escape hatches. Hiding
// a section is cheap to get right and expensive to get wrong — every wrong
// hide is a source the user can no longer reach from the sidebar, and two of
// the three "empty" signals here (not-loaded-yet, signed-out) are states a
// naive count-based rule reads as "nothing connected".

import Foundation
import XCTest

@testable import Maple_Exposure

final class LibrarySidebarVMTests: XCTestCase {

    // MARK: - Folders

    func testFoldersSectionHidesOnlyWhenNothingIsSaved() {
        XCTAssertFalse(LibrarySidebarVM.showsFoldersSection(savedFolderCount: 0))
        XCTAssertTrue(LibrarySidebarVM.showsFoldersSection(savedFolderCount: 1))
        XCTAssertTrue(LibrarySidebarVM.showsFoldersSection(savedFolderCount: 12))
    }

    // MARK: - Connections (SMB)

    func testConnectionsSectionHidesOnlyWhenNoShareIsSaved() {
        XCTAssertFalse(LibrarySidebarVM.showsConnectionsSection(savedShareCount: 0))
        XCTAssertTrue(LibrarySidebarVM.showsConnectionsSection(savedShareCount: 1))
    }

    // MARK: - Cloud servers

    /// The only hiding case: we know the answer and the answer is zero.
    func testCloudServerHidesWhenSignedInAndNoRootIsReachable() {
        XCTAssertFalse(
            LibrarySidebarVM.showsCloudServerSection(
                isSignedIn: true, hasFileAccess: true, connectedFolderCount: 0
            )
        )
    }

    func testCloudServerShowsWhenAtLeastOneRootIsReachable() {
        XCTAssertTrue(
            LibrarySidebarVM.showsCloudServerSection(
                isSignedIn: true, hasFileAccess: true, connectedFolderCount: 1
            )
        )
    }

    /// A member without the file-access permission (#2899) gets an empty
    /// tree, but the section still carries the server's identity and its
    /// sign-out / rename actions — "not allowed to browse" is a different
    /// state from "nothing connected", and only the latter hides.
    func testRestrictedMemberKeepsTheirServerSection() {
        XCTAssertTrue(
            LibrarySidebarVM.showsCloudServerSection(
                isSignedIn: true, hasFileAccess: false, connectedFolderCount: 0
            )
        )
        XCTAssertTrue(
            LibrarySidebarVM.showsCloudServerSection(
                isSignedIn: true, hasFileAccess: false, connectedFolderCount: 3
            )
        )
    }

    /// A signed-out server reports zero folders because it never asked, not
    /// because there are none. Sign-in lives inside the section, so hiding
    /// here would strand the user with no way back in.
    func testSignedOutServerStaysVisibleDespiteReportingZeroFolders() {
        XCTAssertTrue(
            LibrarySidebarVM.showsCloudServerSection(
                isSignedIn: false, hasFileAccess: true, connectedFolderCount: 0
            )
        )
        XCTAssertTrue(
            LibrarySidebarVM.showsCloudServerSection(
                isSignedIn: false, hasFileAccess: false, connectedFolderCount: nil
            )
        )
    }

    /// `nil` is "the fetch hasn't finished", which is every server for the
    /// first moments of a cold launch. Treating it as zero would make every
    /// server flicker out and back in on every launch.
    func testNotYetLoadedServerStaysVisible() {
        XCTAssertTrue(
            LibrarySidebarVM.showsCloudServerSection(
                isSignedIn: true, hasFileAccess: true, connectedFolderCount: nil
            )
        )
    }

    // MARK: - Photos

    /// Not a tautology worth deleting: an unauthorized library reports zero
    /// photos, so anyone extending the count-based rule above to Photos
    /// would hide the section exactly when the user needs it — the panel
    /// behind it is the only route to granting access (#2454, #2924).
    func testPhotosSectionIsNeverHidden() {
        XCTAssertTrue(LibrarySidebarVM.showsPhotosSection)
    }
}
