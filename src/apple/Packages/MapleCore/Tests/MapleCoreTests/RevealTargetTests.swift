// RevealTargetTests.swift — AssetRef.revealTarget derivation (#2518).

import XCTest
@testable import MapleCore

final class RevealTargetTests: XCTestCase {
    func testCloudAssetRevealsLibraryAtParentDir() {
        let ref = AssetRef(
            displayName: "IMG_0042.dng", hintExtension: "dng",
            stableID: "fs:/srv/lib/2026/IMG_0042.dng",
            catalog: CatalogRef(
                serverID: URL(string: "https://maple.example")!,
                folderID: "F1",
                absPath: "/srv/lib/2026/IMG_0042.dng",
                address: "lib:2026/IMG_0042.dng"),
            bytesProvider: { Data() })
        XCTAssertEqual(
            ref.revealTarget,
            .cloud(serverID: URL(string: "https://maple.example")!,
                   folderID: "F1",
                   libraryPath: "/srv/lib/2026"))
        // Displayed folder is the library-relative address, filename dropped,
        // colon rendered as a slash — NOT the server /srv abs path.
        XCTAssertEqual(ref.displayFolder, "lib/2026")
    }

    func testCloudAssetAtLibraryRootShowsSlugOnly() {
        let ref = AssetRef(
            displayName: "x.dng", hintExtension: "dng", stableID: "fs:/srv/lib/x.dng",
            catalog: CatalogRef(
                serverID: URL(string: "https://maple.example")!, folderID: "F1",
                absPath: "/srv/lib/x.dng", address: "lib:x.dng"),
            bytesProvider: { Data() })
        XCTAssertEqual(ref.displayFolder, "lib")
    }

    func testLocalAssetRevealsParentFolder() {
        let url = URL(fileURLWithPath: "/photos/2026/IMG_0042.dng")
        let ref = AssetRef(url: url)
        XCTAssertEqual(ref.revealTarget, .local(parent: url.deletingLastPathComponent()))
        XCTAssertEqual(ref.displayFolder, "/photos/2026")
    }

    func testPhotoKitAssetHasNoRevealTarget() {
        // No URL, no catalog — a PhotoKit-shaped ref.
        let ref = AssetRef(
            displayName: "IMG_0042", hintExtension: "heic",
            stableID: "phasset-local-id", bytesProvider: { Data() })
        XCTAssertEqual(ref.revealTarget, .none)
        XCTAssertNil(ref.displayFolder)
    }
}
