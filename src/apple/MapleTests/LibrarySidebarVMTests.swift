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
import MapleCore
import XCTest

@testable import Maple

final class LibrarySidebarVMTests: XCTestCase {

  private let serverA = URL(string: "https://a.maple.invalid")!
  private let serverB = URL(string: "https://b.maple.invalid")!
  private let share = SMBCredentialStore.SavedShare(
    host: "nas.local", share: "Photos", username: "user"
  )

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

  /// A member without the file-access permission (#2899) is served an
  /// empty tree and 403'd server-side if they try anyway, so the section
  /// is a header over content they cannot reach — it hides.
  ///
  /// The second assertion is the one with teeth: the roots ARE connected,
  /// so a rule that only counted reachable folders would leave this
  /// member staring at a server they can't open. Permission is checked
  /// before the count for exactly that reason.
  func testRestrictedMemberDoesNotSeeTheServerAtAll() {
    XCTAssertFalse(
      LibrarySidebarVM.showsCloudServerSection(
        isSignedIn: true, hasFileAccess: false, connectedFolderCount: 0
      )
    )
    XCTAssertFalse(
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

  // MARK: - macOS auto-expand (#4152, #4157 review)

  func testCloudSectionExpandsWhenPathChangesOnItsOwnServer() {
    XCTAssertTrue(
      LibrarySidebarVM.shouldExpandCloudSection(
        currentPath: "/photos/2024",
        selection: .cloudLibrary(serverID: serverA, folderID: "1"),
        sectionServer: serverA
      )
    )
  }

  /// The #4157 finding: every section observes the same path signal, so
  /// an unscoped rule expands ALL servers when one is browsed. Browsing
  /// server A must leave server B's section exactly as the user left it.
  func testCloudSectionIgnoresPathsOnOtherServers() {
    XCTAssertFalse(
      LibrarySidebarVM.shouldExpandCloudSection(
        currentPath: "/photos/2024",
        selection: .cloudLibrary(serverID: serverA, folderID: "1"),
        sectionServer: serverB
      )
    )
  }

  /// Exhaustive over the non-cloud cases: a stale non-nil path observed
  /// while anything else is selected must not expand any cloud section.
  func testCloudSectionIgnoresPathsForNonCloudSelections() {
    let selections: [LibrarySelection] = [
      .none,
      .folder(path: "/Photos"),
      .photosFilter(.all),
      .smbShare(share),
      .allSources,
      .map,
    ]
    for selection in selections {
      XCTAssertFalse(
        LibrarySidebarVM.shouldExpandCloudSection(
          currentPath: "/photos/2024",
          selection: selection,
          sectionServer: serverA
        ),
        "selection \(selection) must not expand a cloud section"
      )
    }
  }

  /// `nil` is "no cloud library is browsed" — including every server
  /// except the selected one, which the parent feeds `nil` via
  /// `pathFor(server:)`. Nothing to reveal, nothing expands.
  func testCloudSectionStaysPutWhenNoPathIsBrowsed() {
    XCTAssertFalse(
      LibrarySidebarVM.shouldExpandCloudSection(
        currentPath: nil,
        selection: .cloudLibrary(serverID: serverA, folderID: "1"),
        sectionServer: serverA
      )
    )
  }

  /// The SMB group opens for share selections and nothing else. The rule
  /// lives in the parent sidebar (the SMB layer), not in the generic
  /// `DisclosureRow` — this pins the behavior the move preserves.
  func testSMBGroupExpandsOnlyForShareSelections() {
    XCTAssertTrue(
      LibrarySidebarVM.shouldExpandSMBGroup(selection: .smbShare(share))
    )
    let others: [LibrarySelection] = [
      .none,
      .folder(path: "/Photos"),
      .photosFilter(.all),
      .cloudLibrary(serverID: serverA, folderID: "1"),
      .allSources,
      .map,
    ]
    for selection in others {
      XCTAssertFalse(
        LibrarySidebarVM.shouldExpandSMBGroup(selection: selection),
        "selection \(selection) must not expand the SMB group"
      )
    }
  }

}
