// AssetRefCatalogTests.swift — CatalogRef carriage on AssetRef (#2518).

import XCTest
@testable import MapleCore

final class AssetRefCatalogTests: XCTestCase {
    func testFilesystemRefHasNoCatalog() {
        let ref = AssetRef(url: URL(fileURLWithPath: "/photos/2026/IMG_0042.dng"))
        XCTAssertNil(ref.catalog)
    }

    func testCloudRefRoundTripsCatalog() async throws {
        let catalog = CatalogRef(
            serverID: URL(string: "https://maple.example")!,
            folderID: "652f0000000000000000abcd",
            absPath: "/srv/lib/2026/IMG_0042.dng",
            address: "lib:2026/IMG_0042.dng"
        )
        let ref = AssetRef(
            displayName: "IMG_0042.dng",
            hintExtension: "dng",
            stableID: "fs:/srv/lib/2026/IMG_0042.dng",
            catalog: catalog,
            bytesProvider: { Data() }
        )
        XCTAssertEqual(ref.catalog?.serverID, URL(string: "https://maple.example")!)
        XCTAssertEqual(ref.catalog?.folderID, "652f0000000000000000abcd")
        XCTAssertEqual(ref.catalog?.absPath, "/srv/lib/2026/IMG_0042.dng")
        XCTAssertEqual(ref.catalog?.address, "lib:2026/IMG_0042.dng")
        // stableID stays the fs:<absPath> thumbnail key — unchanged by catalog.
        XCTAssertEqual(ref.stableID, "fs:/srv/lib/2026/IMG_0042.dng")
    }

    func testCloudRefCatalogDefaultsNil() {
        let ref = AssetRef(
            displayName: "x.dng", hintExtension: "dng", stableID: "fs:/x.dng",
            bytesProvider: { Data() }
        )
        XCTAssertNil(ref.catalog)
    }
}
