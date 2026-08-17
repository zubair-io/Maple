// AssetRenameFilenameTests.swift — AssetRef.fullFilename and
// AssetRenameFilename.extensionChanged (#2842).

import XCTest
@testable import MapleCore

final class AssetRenameFilenameTests: XCTestCase {
    private func localAsset(_ path: String) -> AssetRef {
        AssetRef(url: URL(fileURLWithPath: path))
    }

    private func bytesBackedAsset(_ name: String) -> AssetRef {
        AssetRef(
            displayName: name, hintExtension: "dng",
            stableID: "phasset-\(name)",
            bytesProvider: { Data() })
    }

    // MARK: - fullFilename

    func testLocalAsset_UsesURLLastPathComponent() {
        XCTAssertEqual(localAsset("/photos/2026/IMG_0001.dng").fullFilename, "IMG_0001.dng")
    }

    func testBytesBackedAsset_UsesDisplayNameVerbatim() {
        // Bytes-backed refs (SMB/Cloud/PhotoKit) already carry the full
        // filename in displayName, unlike primaryURL-backed refs where
        // displayName is stripped of its extension.
        XCTAssertEqual(bytesBackedAsset("IMG_0002.dng").fullFilename, "IMG_0002.dng")
    }

    func testLocalAsset_NestedDirectory_OnlyLastComponent() {
        XCTAssertEqual(localAsset("/a/b/c/photo.cr3").fullFilename, "photo.cr3")
    }

    // MARK: - extensionChanged(from:to:)

    func testSameExtension_ReportsNoChange() {
        XCTAssertFalse(AssetRenameFilename.extensionChanged(from: "a.dng", to: "b.dng"))
    }

    func testDifferentExtension_ReportsChange() {
        XCTAssertTrue(AssetRenameFilename.extensionChanged(from: "a.dng", to: "a.jpg"))
    }

    func testExtensionCaseDifference_IsNotAChange() {
        XCTAssertFalse(AssetRenameFilename.extensionChanged(from: "a.DNG", to: "a.dng"))
    }

    func testOriginalHasNoExtension_NeverReportsChange() {
        XCTAssertFalse(AssetRenameFilename.extensionChanged(from: "README", to: "README.md"))
    }

    func testNewFilenameDropsExtension_ReportsChange() {
        XCTAssertTrue(AssetRenameFilename.extensionChanged(from: "a.dng", to: "a"))
    }

    func testStemOnlyChange_NoExtensionChange() {
        XCTAssertFalse(AssetRenameFilename.extensionChanged(from: "sunset.jpg", to: "sunset-edit.jpg"))
    }
}
