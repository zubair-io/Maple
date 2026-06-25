// PhotoGridItemTests.swift — unit tests for the PhotoGridItem model and adapters.
//
// Tests for: default overlays, Identifiable id passthrough, Hashable equality,
// per-surface adapters (local / cloud / merged), and ThumbnailSource routing.
// Ticket #1490 M0.
//
// M1b additions: displayName threading through each adapter, and
// MergedTimelineCell.Identifiable conformance.

import XCTest
@testable import MapleCore

final class PhotoGridItemTests: XCTestCase {

    // MARK: - Default overlays

    func testDefaultOverlaysAreEmpty() {
        let item = PhotoGridItem(id: "x", displayName: "x.dng",
                                 thumbnailSource: .photoKit(localID: "x"))
        XCTAssertEqual(item.overlays.rating, 0)
        XCTAssertNil(item.overlays.flag)
        XCTAssertNil(item.overlays.sync)
        XCTAssertFalse(item.overlays.isVideo)
        XCTAssertEqual(item.overlays.style, .phone)
    }

    // MARK: - Identifiable

    func testIdPassthrough() {
        let item = PhotoGridItem(id: "abc-123", displayName: "test.dng",
                                 thumbnailSource: .photoKit(localID: "abc-123"))
        XCTAssertEqual(item.id, "abc-123")
    }

    func testDisplayNamePassthrough() {
        let item = PhotoGridItem(id: "x", displayName: "IMG_0001.dng",
                                 thumbnailSource: .photoKit(localID: "x"))
        XCTAssertEqual(item.displayName, "IMG_0001.dng")
    }

    // MARK: - Hashable (id-based)

    func testEqualitySameIDAndOverlaysIgnoresSource() {
        let a = PhotoGridItem(
            id: "same",
            displayName: "a.dng",
            thumbnailSource: .photoKit(localID: "local1"),
            overlays: GridCellOverlays(rating: 2)
        )
        let b = PhotoGridItem(
            id: "same",
            displayName: "b.dng",
            thumbnailSource: .cloud(absPath: "/photos/img.dng", host: "server"),
            overlays: GridCellOverlays(rating: 2)
        )
        XCTAssertEqual(a, b, "Same id + same overlays are equal regardless of thumbnail source or displayName")
    }

    func testInequalityWhenOverlaysDiffer() {
        // Critical for SwiftUI: a stable id with changed badges (rating/flag/sync)
        // must compare UNEQUAL so the cell re-renders. (#1490 review — Jules)
        let a = PhotoGridItem(id: "same", displayName: "x.dng",
                              thumbnailSource: .photoKit(localID: "l"))
        let b = PhotoGridItem(
            id: "same",
            displayName: "x.dng",
            thumbnailSource: .photoKit(localID: "l"),
            overlays: GridCellOverlays(rating: 5)
        )
        XCTAssertNotEqual(a, b, "Same id but different overlays must NOT be equal")
        XCTAssertEqual(a.hashValue, b.hashValue, "hash stays id-based — collision is permitted")
    }

    func testHashableInequalityOnDifferentID() {
        let a = PhotoGridItem(id: "aaa", displayName: "a.dng",
                              thumbnailSource: .photoKit(localID: "x"))
        let b = PhotoGridItem(id: "bbb", displayName: "b.dng",
                              thumbnailSource: .photoKit(localID: "x"))
        XCTAssertNotEqual(a, b)
    }

    func testHashableSetMembership() {
        let a = PhotoGridItem(id: "dup", displayName: "a.dng",
                              thumbnailSource: .photoKit(localID: "1"))
        let b = PhotoGridItem(id: "dup", displayName: "b.dng",
                              thumbnailSource: .photoKit(localID: "2"))
        var set = Set<PhotoGridItem>()
        set.insert(a)
        set.insert(b)
        XCTAssertEqual(set.count, 1, "Set must deduplicate items with the same id")
    }

    // MARK: - GridCellOverlays Hashable

    func testOverlaysEquality() {
        let a = GridCellOverlays(rating: 4, flag: .pick, sync: .synced, isVideo: false, style: .desktop)
        let b = GridCellOverlays(rating: 4, flag: .pick, sync: .synced, isVideo: false, style: .desktop)
        XCTAssertEqual(a, b)
    }

    func testOverlaysInequality() {
        let a = GridCellOverlays(rating: 3)
        let b = GridCellOverlays(rating: 4)
        XCTAssertNotEqual(a, b)
    }

    // MARK: - Local asset adapter

    func testLocalAdapterUsesStableID() {
        let asset = AssetRef(
            displayName: "IMG_0001.dng",
            hintExtension: "dng",
            stableID: "stable-abc",
            bytesProvider: { throw NSError(domain: "test", code: -1) }
        )
        let overlays = GridCellOverlays(rating: 3, flag: .pick, style: .desktop)
        let item = PhotoGridItem(local: asset, source: nil, overlays: overlays)
        XCTAssertEqual(item.id, "stable-abc")
        XCTAssertEqual(item.displayName, "IMG_0001.dng")
        XCTAssertEqual(item.overlays.rating, 3)
        XCTAssertEqual(item.overlays.flag, .pick)
    }

    func testLocalAdapterFallsBackToUUIDWhenNoStableID() {
        let asset = AssetRef(
            displayName: "noID.dng",
            hintExtension: "dng",
            stableID: nil,
            bytesProvider: { throw NSError(domain: "test", code: -1) }
        )
        let item = PhotoGridItem(local: asset, source: nil, overlays: .init())
        XCTAssertFalse(item.id.isEmpty, "id must not be empty even without a stableID")
        XCTAssertEqual(item.displayName, "noID.dng")
    }

    // MARK: - Cloud asset adapter

    func testCloudAdapterPickFlag() {
        let asset = SearchAsset(
            id: "cloud-001",
            folder_id: "f1",
            abs_path: "/photos/a.dng",
            filename: "a.dng",
            rating: 4,
            flag: 1
        )
        let item = PhotoGridItem(cloud: asset, host: "myserver", style: .phone)
        XCTAssertEqual(item.id, "cloud-001")
        XCTAssertEqual(item.displayName, "a.dng")
        XCTAssertEqual(item.overlays.rating, 4)
        XCTAssertEqual(item.overlays.flag, .pick)
        if case .cloud(let absPath, let host) = item.thumbnailSource {
            XCTAssertEqual(absPath, "/photos/a.dng")
            XCTAssertEqual(host, "myserver")
        } else {
            XCTFail("Expected .cloud thumbnail source")
        }
    }

    func testCloudAdapterRejectFlag() {
        let asset = SearchAsset(
            id: "cloud-002",
            folder_id: "f1",
            abs_path: "/photos/b.dng",
            filename: "b.dng",
            flag: -1
        )
        let item = PhotoGridItem(cloud: asset, host: "h", style: .desktop)
        XCTAssertEqual(item.overlays.flag, .reject)
        XCTAssertEqual(item.displayName, "b.dng")
    }

    func testCloudAdapterNilFlag() {
        let asset = SearchAsset(
            id: "cloud-003",
            folder_id: "f1",
            abs_path: "/photos/c.dng",
            filename: "c.dng",
            flag: nil
        )
        let item = PhotoGridItem(cloud: asset, host: "h", style: .phone)
        XCTAssertNil(item.overlays.flag)
    }

    // MARK: - Merged timeline cell adapter

    func testMergedAdapterSyncedUseLocalID() {
        let local = ImageRef(id: "local-id", displayName: "local.dng")
        let cloud = ImageRef(id: "cloud-id", displayName: "cloud.dng")
        let cell = MergedTimelineCell.synced(local: local, cloud: cloud)
        let item = PhotoGridItem(merged: cell, host: "h", sync: .synced, style: .phone)
        // renderID for .synced returns the local id
        XCTAssertEqual(item.id, "local-id")
        XCTAssertEqual(item.displayName, "local.dng", "displayName prefers local ref for .synced")
        XCTAssertEqual(item.overlays.sync, .synced)
    }

    func testMergedAdapterCloudOnlyID() {
        let cloudRef = ImageRef(id: "cloud-ref", displayName: "cloud.dng")
        let cell = MergedTimelineCell.cloudOnly(cloudRef)
        let item = PhotoGridItem(merged: cell, host: "myhost", sync: .cloudOnly, style: .desktop)
        XCTAssertEqual(item.id, "cloud-ref")
        XCTAssertEqual(item.displayName, "cloud.dng")
        XCTAssertEqual(item.overlays.sync, .cloudOnly)
    }

    func testMergedAdapterLocalOnlyID() {
        let localRef = ImageRef(id: "local-ref", displayName: "local.dng")
        let cell = MergedTimelineCell.localOnly(localRef)
        let item = PhotoGridItem(merged: cell, host: "h", sync: .localOnly, style: .phone)
        XCTAssertEqual(item.id, "local-ref")
        XCTAssertEqual(item.displayName, "local.dng")
        XCTAssertEqual(item.overlays.sync, .localOnly)
    }

    // MARK: - OverlayStyle.cloud (M2)

    /// `.cloud` style must be distinct from `.phone` and `.desktop` so GridCellOverlays
    /// that differ only by style compare unequal (driving cell re-renders on style changes).
    func testCloudOverlayStyleDistinct() {
        let phone   = GridCellOverlays(rating: 3, style: .phone)
        let desktop = GridCellOverlays(rating: 3, style: .desktop)
        let cloud   = GridCellOverlays(rating: 3, style: .cloud)
        XCTAssertNotEqual(phone, desktop)
        XCTAssertNotEqual(phone, cloud)
        XCTAssertNotEqual(desktop, cloud)
    }

    /// Cloud adapter with `.cloud` style carries the rating and uses the cloud ThumbnailSource.
    func testCloudAdapterWithCloudStyle() {
        let asset = SearchAsset(
            id: "cloud-cloud-style",
            folder_id: "f1",
            abs_path: "/photos/cloud.dng",
            filename: "cloud.dng",
            rating: 3,
            flag: nil
        )
        let item = PhotoGridItem(cloud: asset, host: "myhost", style: .cloud)
        XCTAssertEqual(item.overlays.style, .cloud)
        XCTAssertEqual(item.overlays.rating, 3)
        XCTAssertNil(item.overlays.sync, "cloud-only cells have no sync badge")
    }

    /// SearchAsset.Identifiable: id is the server-assigned asset id (M2).
    func testSearchAssetIdentifiable() {
        let asset = SearchAsset(id: "sa-id-123", folder_id: "f", abs_path: "/a.dng", filename: "a.dng")
        XCTAssertEqual(asset.id, "sa-id-123")
    }

    // MARK: - MergedTimelineCell Identifiable (M1b)

    func testMergedCellIdentifiableSynced() {
        let local = ImageRef(id: "l-id", displayName: "local.dng")
        let cloud = ImageRef(id: "c-id", displayName: "cloud.dng")
        let cell = MergedTimelineCell.synced(local: local, cloud: cloud)
        // .id must equal MergedTimelineSource.renderID (local id for .synced)
        XCTAssertEqual(cell.id, "l-id")
    }

    func testMergedCellIdentifiableCloudOnly() {
        let cloudRef = ImageRef(id: "cloud-only-id", displayName: "c.dng")
        let cell = MergedTimelineCell.cloudOnly(cloudRef)
        XCTAssertEqual(cell.id, "cloud-only-id")
    }

    func testMergedCellIdentifiableLocalOnly() {
        let localRef = ImageRef(id: "local-only-id", displayName: "l.dng")
        let cell = MergedTimelineCell.localOnly(localRef)
        XCTAssertEqual(cell.id, "local-only-id")
    }

    // MARK: - ThumbnailSource.resolvedBackend (pure routing)

    func testBackendRoutingPhotoKit() {
        let source = ThumbnailSource.photoKit(localID: "pk-id")
        guard case .photoKit(let lid) = source.resolvedBackend() else {
            XCTFail("Expected .photoKit backend"); return
        }
        XCTAssertEqual(lid, "pk-id")
    }

    func testBackendRoutingCloud() {
        let source = ThumbnailSource.cloud(absPath: "/a/b.dng", host: "server")
        guard case .cloudThumb(let absPath, let host) = source.resolvedBackend() else {
            XCTFail("Expected .cloudThumb backend"); return
        }
        XCTAssertEqual(absPath, "/a/b.dng")
        XCTAssertEqual(host, "server")
    }

    func testBackendRoutingLocal() {
        let asset = AssetRef.preview()
        let source = ThumbnailSource.local(asset, source: nil)
        guard case .thumbnailLoader(let ref, _) = source.resolvedBackend() else {
            XCTFail("Expected .thumbnailLoader backend"); return
        }
        XCTAssertEqual(ref.id, asset.id)
    }

    func testBackendRoutingMergedSyncedResolvesToPhotoKit() {
        let local = ImageRef(id: "local-abc", displayName: "l.dng")
        let cloud = ImageRef(id: "cloud-xyz", displayName: "c.dng")
        let cell = MergedTimelineCell.synced(local: local, cloud: cloud)
        let source = ThumbnailSource.merged(cell, host: "h")
        guard case .photoKit(let lid) = source.resolvedBackend() else {
            XCTFail("Expected .photoKit for .synced merged cell"); return
        }
        XCTAssertEqual(lid, "local-abc")
    }

    func testBackendRoutingMergedLocalOnlyResolvesToPhotoKit() {
        let local = ImageRef(id: "local-only", displayName: "l.dng")
        let cell = MergedTimelineCell.localOnly(local)
        let source = ThumbnailSource.merged(cell, host: "h")
        guard case .photoKit(let lid) = source.resolvedBackend() else {
            XCTFail("Expected .photoKit for .localOnly merged cell"); return
        }
        XCTAssertEqual(lid, "local-only")
    }

    func testBackendRoutingMergedCloudOnlyResolvesToCloudThumb() {
        let cloudRef = ImageRef(id: "fs:/photos/img.dng", displayName: "img.dng")
        let cell = MergedTimelineCell.cloudOnly(cloudRef)
        let source = ThumbnailSource.merged(cell, host: "myserver")
        guard case .cloudThumb(let absPath, let host) = source.resolvedBackend() else {
            XCTFail("Expected .cloudThumb for .cloudOnly merged cell"); return
        }
        XCTAssertEqual(absPath, "/photos/img.dng")
        XCTAssertEqual(host, "myserver")
    }

    func testBackendRoutingMergedCloudOnlyNoFsPrefix() {
        // Cloud refs without "fs:" prefix pass id directly as abs_path
        let cloudRef = ImageRef(id: "/direct/path.dng", displayName: "path.dng")
        let cell = MergedTimelineCell.cloudOnly(cloudRef)
        let source = ThumbnailSource.merged(cell, host: "srv")
        guard case .cloudThumb(let absPath, _) = source.resolvedBackend() else {
            XCTFail("Expected .cloudThumb backend"); return
        }
        XCTAssertEqual(absPath, "/direct/path.dng")
    }
}
