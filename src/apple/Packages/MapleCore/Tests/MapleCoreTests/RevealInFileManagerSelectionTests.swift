// RevealInFileManagerSelectionTests.swift — AssetRef.isRevealEligible and
// RevealInFileManagerSelection.urls(for:in:) (#2658).

import XCTest
@testable import MapleCore

final class RevealInFileManagerSelectionTests: XCTestCase {
    private func localAsset(_ path: String) -> AssetRef {
        AssetRef(url: URL(fileURLWithPath: path))
    }

    private func cloudAsset(_ name: String) -> AssetRef {
        AssetRef(
            displayName: name, hintExtension: "dng",
            stableID: "fs:/srv/lib/\(name)",
            catalog: CatalogRef(
                serverID: URL(string: "https://maple.example")!,
                folderID: "F1",
                absPath: "/srv/lib/\(name)",
                address: "lib:\(name)"),
            bytesProvider: { Data() })
    }

    private func photoKitAsset(_ name: String) -> AssetRef {
        AssetRef(
            displayName: name, hintExtension: "heic",
            stableID: "phasset-\(name)",
            bytesProvider: { Data() })
    }

    // MARK: - isRevealEligible

    func testLocalAssetIsEligible() {
        XCTAssertTrue(localAsset("/photos/2026/a.dng").isRevealEligible)
    }

    func testCloudAssetIsNotEligible() {
        XCTAssertFalse(cloudAsset("a.dng").isRevealEligible)
    }

    func testPhotoKitAssetIsNotEligible() {
        XCTAssertFalse(photoKitAsset("a").isRevealEligible)
    }

    // MARK: - urls(for:in:)

    func testMixedSelection_OnlyEligibleURLsReturned_InGridOrder() {
        let local1 = localAsset("/photos/2026/a.dng")
        let cloud = cloudAsset("b.dng")
        let local2 = localAsset("/photos/2026/c.dng")
        let assets = [local1, cloud, local2]
        let ids = Set([local1.id, cloud.id, local2.id])

        let urls = RevealInFileManagerSelection.urls(for: ids, in: assets)

        XCTAssertEqual(urls, [local1.primaryURL!, local2.primaryURL!])
    }

    func testAllIneligibleSelection_ReturnsEmpty() {
        let cloud = cloudAsset("a.dng")
        let photoKit = photoKitAsset("b")
        let assets = [cloud, photoKit]
        let ids = Set([cloud.id, photoKit.id])

        XCTAssertTrue(RevealInFileManagerSelection.urls(for: ids, in: assets).isEmpty)
    }

    func testEmptySelection_ReturnsEmpty() {
        let assets = [localAsset("/photos/2026/a.dng")]

        XCTAssertTrue(RevealInFileManagerSelection.urls(for: [], in: assets).isEmpty)
    }

    func testSingleEligibleAssetInLargerSelection() {
        let local = localAsset("/photos/2026/a.dng")
        let cloud = cloudAsset("b.dng")
        let assets = [local, cloud]
        let ids = Set([local.id, cloud.id])

        XCTAssertEqual(RevealInFileManagerSelection.urls(for: ids, in: assets), [local.primaryURL!])
    }
}
