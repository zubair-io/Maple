// LibrarySourcesVMTests.swift — unit tests for the pure helpers in
// `Maple/Views/LibrarySourcesSettingsView+VM.swift` (#2925).

import Foundation
import MapleCore
import XCTest

@testable import Maple_Exposure

final class LibrarySourcesVMTests: XCTestCase {

    private func folder(_ path: String) -> SavedFolder {
        SavedFolder(
            path: path,
            displayName: (path as NSString).lastPathComponent,
            bookmark: Data(),
            lastOpened: Date(timeIntervalSince1970: 0)
        )
    }

    // MARK: - Folders

    func testFolderSubtitleIsTheFullPath() {
        XCTAssertEqual(LibrarySourcesVM.folderSubtitle(folder("/Volumes/Shoots/2026")),
                       "/Volumes/Shoots/2026")
    }

    /// Two folders can share a last path component, which is all
    /// `displayName` holds — so the duplicate check has to be on the path.
    func testAlreadySavedComparesPathsNotDisplayNames() {
        let saved = [folder("/Volumes/A/2026"), folder("/Volumes/B/2025")]
        XCTAssertTrue(LibrarySourcesVM.isAlreadySaved(path: "/Volumes/A/2026", in: saved))
        XCTAssertFalse(LibrarySourcesVM.isAlreadySaved(path: "/Volumes/B/2026", in: saved),
                       "Same folder NAME under a different parent is a different source.")
        XCTAssertFalse(LibrarySourcesVM.isAlreadySaved(path: "/Volumes/C/2026", in: []))
    }

    // MARK: - SMB shares

    func testShareTitleMatchesTheSidebarsHostSlashShareForm() {
        let share = SMBCredentialStore.SavedShare(host: "nas.local", share: "photos", username: "z")
        XCTAssertEqual(LibrarySourcesVM.shareTitle(share), "nas.local / photos")
    }

    /// Two shares differing only by account is exactly when the subtitle
    /// stops being decoration, so an empty username has to render as
    /// something rather than as a blank line.
    func testShareSubtitleNamesTheAccountAndLabelsAnonymousAccessGuest() {
        let named = SMBCredentialStore.SavedShare(host: "nas", share: "raw", username: "zubair")
        let anonymous = SMBCredentialStore.SavedShare(host: "nas", share: "raw", username: "")
        XCTAssertEqual(LibrarySourcesVM.shareSubtitle(named), "zubair")
        XCTAssertEqual(LibrarySourcesVM.shareSubtitle(anonymous), "Guest")
    }

    // MARK: - Servers

    /// Same three-step fallback the sidebar uses, so one server never reads
    /// as two different things across the two surfaces.
    func testServerTitlePrefersDisplayNameThenHostThenURL() {
        let url = URL(string: "https://maple.example.com/api")!
        XCTAssertEqual(LibrarySourcesVM.serverTitle(displayName: "Studio", url: url), "Studio")
        XCTAssertEqual(LibrarySourcesVM.serverTitle(displayName: nil, url: url), "maple.example.com")

        let hostless = URL(string: "file:///srv/maple")!
        XCTAssertEqual(LibrarySourcesVM.serverTitle(displayName: nil, url: hostless),
                       hostless.absoluteString)
    }
}
