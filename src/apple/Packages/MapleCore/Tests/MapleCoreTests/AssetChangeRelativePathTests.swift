// src/apple/Packages/MapleCore/Tests/MapleCoreTests/AssetChangeRelativePathTests.swift
//
// Phase 6 item 2 — the change-feed payload carries `relative_path` so the
// File Provider extension can route per-folder invalidation precisely
// instead of falling back to a synthesized guess. Tests cover both the
// DTO decoder (must tolerate both shapes — with and without the field)
// and the MapleItem stub constructor that turns folderID + relativePath
// into a proper `folder(folderID, parentRelativePath)` parent. Since
// #2537 the stub's own fallback (used only when the enumerator's
// per-asset metadata GET fails) routes to `.rootContainer`, never
// `.workingSet` — `item(for: .workingSet)` unconditionally returns
// `noSuchItem`, so an item parented there could never resolve.

#if canImport(FileProvider)
import XCTest
import FileProvider
@testable import MapleCore

final class AssetChangeRelativePathTests: XCTestCase {

    // MARK: - DTO decoder

    private func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }

    func testDecodesPayloadWithRelativePath() throws {
        let json = #"""
        {
          "cursor": 7,
          "asset_id": "650a",
          "folder_id": "650b",
          "kind": "update",
          "abs_path": "/srv/photos/2024/IMG_0001.dng",
          "relative_path": "2024/IMG_0001.dng",
          "at": "2026-05-17T12:00:00Z"
        }
        """#
        let change = try decoder().decode(AssetChange.self,
                                          from: Data(json.utf8))
        XCTAssertEqual(change.cursor, 7)
        XCTAssertEqual(change.assetID, "650a")
        XCTAssertEqual(change.folderID, "650b")
        XCTAssertEqual(change.absPath, "/srv/photos/2024/IMG_0001.dng")
        XCTAssertEqual(change.relativePath, "2024/IMG_0001.dng")
    }

    func testDecodesLegacyPayloadWithoutRelativePath() throws {
        // Mirrors the pre-Phase-6 wire shape — the `relative_path` key
        // is absent entirely. Decoder must succeed with `nil`.
        let json = #"""
        {
          "cursor": 7,
          "asset_id": "650a",
          "folder_id": "650b",
          "kind": "update",
          "abs_path": "/srv/photos/legacy.dng",
          "at": "2026-05-17T12:00:00Z"
        }
        """#
        let change = try decoder().decode(AssetChange.self,
                                          from: Data(json.utf8))
        XCTAssertNil(change.relativePath)
    }

    func testDecodesExplicitNullRelativePath() throws {
        // Server stores explicit null when absPath doesn't fall under
        // any folder root (defensive case). Decoder must accept either
        // missing-key or explicit-null.
        let json = #"""
        {
          "cursor": 8,
          "asset_id": "650a",
          "folder_id": "650b",
          "kind": "create",
          "abs_path": "/srv/photos/x.dng",
          "relative_path": null,
          "at": "2026-05-17T12:00:00Z"
        }
        """#
        let change = try decoder().decode(AssetChange.self,
                                          from: Data(json.utf8))
        XCTAssertNil(change.relativePath)
    }

    // MARK: - MapleItem stub parent routing

    func testStubParentsUnderFolderWhenRelativePathPresent() throws {
        let item = MapleItem(stubAssetID: "abc",
                             cursor: 42,
                             folderID: "fid",
                             relativePath: "2024/holiday/IMG_0001.dng")
        let parsed = try FileProviderIdentifier(
            rawValue: item.parentItemIdentifier.rawValue
        )
        guard case let .folder(folderID, relPath) = parsed else {
            XCTFail("expected folder(_, _) parent, got \(parsed)")
            return
        }
        XCTAssertEqual(folderID, "fid")
        // Parent is the dirname of the asset's relative path — Finder
        // routes invalidation to the subdirectory the file lives in.
        XCTAssertEqual(relPath, "2024/holiday")
        // Display affordances: filename + UTType derive from the
        // relativePath's basename so Finder paints the right name +
        // icon before `item(for:)` resolves the real metadata.
        XCTAssertEqual(item.filename, "IMG_0001.dng")
    }

    func testStubParentsUnderFolderRootForTopLevelAsset() throws {
        // Top-level asset (no subdirectory) → parent is the folder
        // ROOT identifier (`folder(folderID, "")`), which is the
        // library's display row.
        let item = MapleItem(stubAssetID: "abc",
                             cursor: 1,
                             folderID: "fid",
                             relativePath: "IMG_0002.dng")
        let parsed = try FileProviderIdentifier(
            rawValue: item.parentItemIdentifier.rawValue
        )
        guard case let .folder(folderID, relPath) = parsed else {
            XCTFail("expected folder(_, _) parent, got \(parsed)")
            return
        }
        XCTAssertEqual(folderID, "fid")
        XCTAssertEqual(relPath, "")
        XCTAssertEqual(item.filename, "IMG_0002.dng")
    }

    func testStubFallsBackToRootContainerWhenRelativePathMissing() {
        // Legacy event — no relativePath. Parent must fall back to
        // `.rootContainer` (always-valid). `.workingSet` is NOT a valid
        // fallback: `item(for: .workingSet)` unconditionally returns
        // `noSuchItem` (see `FileProviderExtensionCore.item(for:)`), so
        // an item parented there could never resolve (#2537).
        let item = MapleItem(stubAssetID: "abc",
                             cursor: 1,
                             folderID: "fid",
                             relativePath: nil)
        XCTAssertEqual(item.parentItemIdentifier, .rootContainer)
        XCTAssertNotEqual(item.parentItemIdentifier, .workingSet)
        // No filename hint to derive from — keep the (stub) marker so
        // the call site is obvious in any log. This constructor is now
        // reached only as a last-resort fallback when the enumerator's
        // per-asset metadata GET fails (see `WorkingSetEnumerator
        // .enumerateChanges`), not on the routine path.
        XCTAssertEqual(item.filename, "(stub)")
    }

    func testStubFallsBackToRootContainerWhenFolderIDMissing() {
        // Defensive — server event somehow carries relativePath but no
        // folderID. We can't build a folder identifier without the
        // folder ID, so fall back to `.rootContainer`, never
        // `.workingSet`.
        let item = MapleItem(stubAssetID: "abc",
                             cursor: 1,
                             folderID: nil,
                             relativePath: "2024/x.dng")
        XCTAssertEqual(item.parentItemIdentifier, .rootContainer)
        XCTAssertNotEqual(item.parentItemIdentifier, .workingSet)
    }

    func testStubLegacyConstructorRoutesToRootContainer() {
        // The original 2-arg init (no folder info at all) must fall
        // back to `.rootContainer` for any caller that hasn't been
        // updated yet — the new arguments are default-nil. Never
        // `.workingSet` (#2537).
        let item = MapleItem(stubAssetID: "abc", cursor: 1)
        XCTAssertEqual(item.parentItemIdentifier, .rootContainer)
        XCTAssertNotEqual(item.parentItemIdentifier, .workingSet)
        XCTAssertEqual(item.filename, "(stub)")
    }
}
#endif
