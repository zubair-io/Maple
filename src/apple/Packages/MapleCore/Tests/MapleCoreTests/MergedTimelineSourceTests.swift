import XCTest
@testable import MapleCore

final class MergedTimelineSourceTests: XCTestCase {

    private func date(_ iso: String) -> Date {
        ISO8601DateFormatter().date(from: iso)!
    }

    func testEmptyInputsEmptyOutput() {
        XCTAssertEqual(MergedTimelineSource.merge(local: [], cloud: []).count, 0)
    }

    func testLocalOnlyWhenNoCloudMatch() {
        let l = ImageRef(id: "P1", displayName: "P1", captureDate: date("2024-03-15T10:00:00Z"))
        let merged = MergedTimelineSource.merge(local: [l], cloud: [])
        XCTAssertEqual(merged.count, 1)
        guard case .localOnly(let r) = merged[0] else { XCTFail(); return }
        XCTAssertEqual(r.id, "P1")
    }

    func testCloudOnlyWhenLinkAbsent() {
        let c = ImageRef(id: "C1", displayName: "C1",
                         captureDate: date("2024-03-15T10:00:00Z"),
                         phassetLink: nil)
        let merged = MergedTimelineSource.merge(local: [], cloud: [c])
        XCTAssertEqual(merged.count, 1)
        guard case .cloudOnly(let r) = merged[0] else { XCTFail(); return }
        XCTAssertEqual(r.id, "C1")
    }

    func testCloudOnlyWhenLinkDoesNotMatchLocal() {
        let l = ImageRef(id: "P1", displayName: "P1")
        let c = ImageRef(id: "C1", displayName: "C1", phassetLink: "P_OTHER")
        let merged = MergedTimelineSource.merge(local: [l], cloud: [c])
        XCTAssertEqual(merged.count, 2)
        // P1 is local-only; C1 is cloud-only.
        let kinds = merged.map { cell -> String in
            switch cell {
            case .localOnly: return "L"
            case .cloudOnly: return "C"
            case .synced: return "S"
            }
        }.sorted()
        XCTAssertEqual(kinds, ["C", "L"])
    }

    func testSyncedWhenCloudLinkMatchesLocal() {
        let l = ImageRef(id: "P1", displayName: "P1",
                         captureDate: date("2024-03-15T10:00:00Z"))
        let c = ImageRef(id: "C1", displayName: "C1",
                         captureDate: date("2024-03-15T10:00:00Z"),
                         phassetLink: "P1")
        let merged = MergedTimelineSource.merge(local: [l], cloud: [c])
        XCTAssertEqual(merged.count, 1)
        guard case .synced(let local, let cloud) = merged[0] else { XCTFail(); return }
        XCTAssertEqual(local.id, "P1")
        XCTAssertEqual(cloud.id, "C1")
    }

    func testCellsSortedCaptureDateDescending() {
        let older = ImageRef(id: "OLD", displayName: "OLD", captureDate: date("2024-01-01T00:00:00Z"))
        let newer = ImageRef(id: "NEW", displayName: "NEW", captureDate: date("2024-12-01T00:00:00Z"))
        let merged = MergedTimelineSource.merge(local: [older, newer], cloud: [])
        let ids = merged.map { MergedTimelineSource.renderID($0) }
        XCTAssertEqual(ids, ["NEW", "OLD"])
    }

    func testRenderIDPrefersLocalWhenSynced() {
        let l = ImageRef(id: "P1", displayName: "P1")
        let c = ImageRef(id: "C1", displayName: "C1", phassetLink: "P1")
        let merged = MergedTimelineSource.merge(local: [l], cloud: [c])
        XCTAssertEqual(MergedTimelineSource.renderID(merged[0]), "P1")
    }

    func testDoesNotCrashOnDuplicateLocalIDs() {
        let l1 = ImageRef(id: "DUP", displayName: "first")
        let l2 = ImageRef(id: "DUP", displayName: "second")
        // Must not trap; one of the two should win the dedup.
        let merged = MergedTimelineSource.merge(local: [l1, l2], cloud: [])
        XCTAssertEqual(merged.count, 2)  // both local-only cells
    }

    // MARK: - Cross-device cloudIdentifier matching

    /// The whole point of this change: a photo uploaded from device A
    /// surfaces as `.synced` when viewed on device B, even though B's
    /// PHAsset.localIdentifier is different. The cross-device join is
    /// `cloudIdentifier` (PHCloudIdentifier.stringValue).
    func testSyncedAcrossDevicesViaCloudIdentifier() {
        // Local refs are what this device's PhotoKitMergeAdapter built —
        // its own per-device phids paired with a cross-device cloud id.
        let l = ImageRef(id: "DEVICE_B_PHID",
                         displayName: "DEVICE_B_PHID",
                         cloudIdentifier: "icloud-XYZ")
        // Cloud row was uploaded from device A; phasset_links records A's
        // (different) phid plus the same cloud id. The legacy join would
        // have failed because phids don't match — only cloud-id rescues it.
        let c = ImageRef(id: "fs:/lib/a.heic",
                         displayName: "a.heic",
                         phassetLink: "DEVICE_A_PHID",
                         cloudIdentifier: "icloud-XYZ",
                         allPhassetLinks: ["DEVICE_A_PHID"],
                         allCloudIdentifiers: ["icloud-XYZ"])
        let merged = MergedTimelineSource.merge(local: [l], cloud: [c])
        XCTAssertEqual(merged.count, 1)
        guard case .synced(let local, let cloud) = merged[0] else {
            XCTFail("expected .synced via cloud-id, got \(merged[0])")
            return
        }
        XCTAssertEqual(local.id, "DEVICE_B_PHID")
        XCTAssertEqual(cloud.id, "fs:/lib/a.heic")
    }

    /// Cloud-id match must win even when a different local has a phid
    /// match. Prevents the unlikely-but-possible case where two distinct
    /// PhotoKit assets share an id collision but only one has the matching
    /// cloud identifier (the truthful one).
    func testCloudIdMatchPreferredOverPhidMatch() {
        // Two local refs:
        //  - one with cloudIdentifier "icloud-XYZ" but a non-matching phid
        //  - one whose phid happens to match the cloud row's phid, but no cloud id
        let lCloudMatch = ImageRef(id: "B_PHID",
                                   displayName: "B_PHID",
                                   cloudIdentifier: "icloud-XYZ")
        let lPhidMatch = ImageRef(id: "A_PHID",
                                  displayName: "A_PHID")
        // Cloud row carries both a cloud id and a phid; cloud-id wins.
        let c = ImageRef(id: "fs:/lib/a.heic",
                         displayName: "a.heic",
                         phassetLink: "A_PHID",
                         cloudIdentifier: "icloud-XYZ",
                         allPhassetLinks: ["A_PHID"],
                         allCloudIdentifiers: ["icloud-XYZ"])
        let merged = MergedTimelineSource.merge(
            local: [lCloudMatch, lPhidMatch], cloud: [c])
        // Two cells: one synced (B_PHID + cloud), one localOnly (A_PHID, the
        // local that lost the cloud-id race for the same cloud row).
        XCTAssertEqual(merged.count, 2)
        let synced = merged.compactMap {
            if case .synced(let local, _) = $0 { return local.id } else { return nil }
        }
        XCTAssertEqual(synced, ["B_PHID"],
                       "cloud-id match must be preferred over phid match")
        // The phid-matched local should fall out as .localOnly.
        XCTAssertTrue(merged.contains(where: {
            if case .localOnly(let r) = $0, r.id == "A_PHID" { return true }
            return false
        }))
    }

    /// Phid is the fallback join key when both sides lack a cloud id (e.g.
    /// the user has iCloud Photos turned off, so cloudIdentifierMappings
    /// returns failures across the board).
    func testPhidFallbackWhenBothSidesHaveNoCloudId() {
        let l = ImageRef(id: "P1", displayName: "P1")
        let c = ImageRef(id: "C1", displayName: "C1",
                         phassetLink: "P1",
                         allPhassetLinks: ["P1"])
        let merged = MergedTimelineSource.merge(local: [l], cloud: [c])
        XCTAssertEqual(merged.count, 1)
        guard case .synced = merged[0] else {
            XCTFail("expected .synced via phid fallback, got \(merged[0])")
            return
        }
    }

    /// Multi-device cloud row: `phasset_links` has TWO entries, the matching
    /// one is at index [1]. Today's bug walked only `phasset_links[0]`; the
    /// fix must walk every entry.
    func testWalksEveryEntryInAllPhassetLinks() {
        // Local has B's phid only.
        let l = ImageRef(id: "B_PHID", displayName: "B_PHID")
        // Cloud row recorded uploads from A (index 0) and B (index 1).
        let c = ImageRef(id: "fs:/lib/a.heic",
                         displayName: "a.heic",
                         phassetLink: "A_PHID",
                         allPhassetLinks: ["A_PHID", "B_PHID"])
        let merged = MergedTimelineSource.merge(local: [l], cloud: [c])
        XCTAssertEqual(merged.count, 1)
        guard case .synced(let local, _) = merged[0] else {
            XCTFail("expected .synced when phid match is at allPhassetLinks[1], got \(merged[0])")
            return
        }
        XCTAssertEqual(local.id, "B_PHID")
    }

    /// Same multi-entry walk for cloud identifiers.
    func testWalksEveryEntryInAllCloudIdentifiers() {
        let l = ImageRef(id: "B_PHID",
                         displayName: "B_PHID",
                         cloudIdentifier: "icloud-B")
        let c = ImageRef(id: "fs:/lib/a.heic",
                         displayName: "a.heic",
                         cloudIdentifier: "icloud-A",
                         allCloudIdentifiers: ["icloud-A", "icloud-B"])
        let merged = MergedTimelineSource.merge(local: [l], cloud: [c])
        XCTAssertEqual(merged.count, 1)
        guard case .synced = merged[0] else {
            XCTFail("expected .synced when cloud-id match is at allCloudIdentifiers[1], got \(merged[0])")
            return
        }
    }

    // MARK: - N-way merge (#2272)

    func testNWayEmptyStreamsProduceEmptyOutput() {
        XCTAssertEqual(MergedTimelineSource.merge(localStreams: [], cloudStreams: []).count, 0)
        XCTAssertEqual(
            MergedTimelineSource.merge(localStreams: [[], []], cloudStreams: [[], [], []]).count,
            0)
    }

    /// The core new capability: the same asset backed up to two different
    /// cloud libraries must collapse to a single cell, not one per library.
    func testMultiCloudDedupSameCloudIdentifier() {
        let cloudLibraryA = [
            ImageRef(id: "cloudA:1", displayName: "a.heic", cloudIdentifier: "icloud-XYZ")
        ]
        let cloudLibraryB = [
            ImageRef(id: "cloudB:1", displayName: "b.heic", cloudIdentifier: "icloud-XYZ")
        ]
        let merged = MergedTimelineSource.merge(
            localStreams: [], cloudStreams: [cloudLibraryA, cloudLibraryB])
        XCTAssertEqual(merged.count, 1, "same cloudIdentifier across 2 cloud libraries must collapse to one cell")
        guard case .cloudOnly(let r) = merged[0] else { XCTFail(); return }
        // First-stream-wins: library A's row is the surviving representative.
        XCTAssertEqual(r.id, "cloudA:1")
    }

    /// Multi-cloud dedup must also work via the phassetLink tier when
    /// neither library populated a cloudIdentifier (e.g. iCloud Photos off).
    func testMultiCloudDedupViaPhassetLink() {
        let cloudLibraryA = [
            ImageRef(id: "cloudA:1", displayName: "a.heic", phassetLink: "PHID_1")
        ]
        let cloudLibraryB = [
            ImageRef(id: "cloudB:1", displayName: "b.heic", phassetLink: "PHID_1")
        ]
        let merged = MergedTimelineSource.merge(
            localStreams: [], cloudStreams: [cloudLibraryA, cloudLibraryB])
        XCTAssertEqual(merged.count, 1)
    }

    /// Multi-cloud dedup via the tertiary plain-id fallback, for two cloud
    /// libraries that share neither a cloudIdentifier nor a phassetLink but
    /// do derive the same content-hash `id`.
    func testMultiCloudDedupViaPlainID() {
        let cloudLibraryA = [ImageRef(id: "shared-hash", displayName: "a.heic")]
        let cloudLibraryB = [ImageRef(id: "shared-hash", displayName: "b.heic")]
        let merged = MergedTimelineSource.merge(
            localStreams: [], cloudStreams: [cloudLibraryA, cloudLibraryB])
        XCTAssertEqual(merged.count, 1)
    }

    /// Key-priority guard: `id` is a LAST-RESORT tier. Two cloud rows that
    /// share a content-hash `id` but carry *different* cloudIdentifiers are
    /// distinct iCloud assets and must NOT be collapsed by the bare-id tier —
    /// the higher-priority cloudIdentifier outranks a shared `id`.
    func testPlainIDDoesNotCollapseRowsWithDifferingCloudIdentifiers() {
        let cloudLibraryA = [
            ImageRef(id: "shared-hash", displayName: "a.heic", cloudIdentifier: "icloud-A")
        ]
        let cloudLibraryB = [
            ImageRef(id: "shared-hash", displayName: "b.heic", cloudIdentifier: "icloud-B")
        ]
        let merged = MergedTimelineSource.merge(
            localStreams: [], cloudStreams: [cloudLibraryA, cloudLibraryB])
        XCTAssertEqual(
            merged.count, 2, "differing cloudIdentifiers outrank a shared content-hash id")
    }

    /// The local↔cloud `id` fallback fires only when the cloud row is keyless.
    /// A keyless cloud row whose `id` equals a PhotoKit local's `id` syncs; a
    /// cloud row carrying a (non-matching) cloudIdentifier must not fall
    /// through to a bare-id match.
    func testLocalIDFallbackOnlyForKeylessCloudRow() {
        let photoKit = [ImageRef(id: "content-1", displayName: "p.heic")]

        let keylessCloud = [ImageRef(id: "content-1", displayName: "c.heic")]
        let syncedMerge = MergedTimelineSource.merge(
            localStreams: [photoKit], cloudStreams: [keylessCloud])
        XCTAssertEqual(syncedMerge.count, 1)
        guard case .synced = syncedMerge[0] else {
            XCTFail("keyless cloud row with matching id should sync, got \(syncedMerge[0])")
            return
        }

        let keyedCloud = [
            ImageRef(id: "content-1", displayName: "c.heic", cloudIdentifier: "icloud-Z")
        ]
        let unmatchedMerge = MergedTimelineSource.merge(
            localStreams: [photoKit], cloudStreams: [keyedCloud])
        XCTAssertEqual(
            unmatchedMerge.count, 2, "a keyed cloud row must not fall through to a bare-id match")
    }

    /// Duplicates WITHIN a single stream must not collapse — only matches
    /// *across* distinct streams do. This mirrors the pre-N-way pairwise
    /// behavior (`testDoesNotCrashOnDuplicateLocalIDs`) generalized to the
    /// cloud side, where a single malformed/duplicated cloud library must
    /// not silently hide a row.
    func testDuplicatesWithinOneCloudStreamDoNotCollapse() {
        let cloudLibraryA = [
            ImageRef(id: "dup-1", displayName: "first", cloudIdentifier: "icloud-XYZ"),
            ImageRef(id: "dup-2", displayName: "second", cloudIdentifier: "icloud-XYZ"),
        ]
        let merged = MergedTimelineSource.merge(localStreams: [], cloudStreams: [cloudLibraryA])
        XCTAssertEqual(merged.count, 2, "same-stream duplicates must remain separate cells")
    }

    /// Cross-device identity join across N streams: an asset present in
    /// PhotoKit AND two cloud libraries collapses to exactly one `.synced`
    /// cell.
    func testSyncedAcrossPhotoKitAndTwoCloudLibraries() {
        let photoKit = [
            ImageRef(id: "PHID_DEVICE", displayName: "PHID_DEVICE", cloudIdentifier: "icloud-XYZ")
        ]
        let cloudLibraryA = [
            ImageRef(id: "cloudA:1", displayName: "a.heic", cloudIdentifier: "icloud-XYZ")
        ]
        let cloudLibraryB = [
            ImageRef(id: "cloudB:1", displayName: "b.heic", cloudIdentifier: "icloud-XYZ")
        ]
        let merged = MergedTimelineSource.merge(
            localStreams: [photoKit], cloudStreams: [cloudLibraryA, cloudLibraryB])
        XCTAssertEqual(merged.count, 1)
        guard case .synced(let local, let cloud) = merged[0] else {
            XCTFail("expected .synced, got \(merged[0])")
            return
        }
        XCTAssertEqual(local.id, "PHID_DEVICE")
        XCTAssertEqual(cloud.id, "cloudA:1")
    }

    /// `.cloudOnly` / `.localOnly` classification generalizes correctly
    /// across several streams on each side.
    func testCloudOnlyAndLocalOnlyClassificationAcrossNStreams() {
        let photoKitA = [ImageRef(id: "L1", displayName: "L1")]
        let photoKitB = [ImageRef(id: "L2", displayName: "L2")]
        let cloudA = [ImageRef(id: "C1", displayName: "C1")]
        let cloudB = [ImageRef(id: "C2", displayName: "C2")]
        let merged = MergedTimelineSource.merge(
            localStreams: [photoKitA, photoKitB], cloudStreams: [cloudA, cloudB])
        XCTAssertEqual(merged.count, 4)
        let kinds = merged.map { cell -> String in
            switch cell {
            case .localOnly: return "L"
            case .cloudOnly: return "C"
            case .synced: return "S"
            }
        }.sorted()
        XCTAssertEqual(kinds, ["C", "C", "L", "L"])
    }

    /// Ordering must stay capture-date descending across every stream, not
    /// just within one.
    func testNWayOrderingIsCaptureDateDescendingAcrossAllStreams() {
        let photoKit = [
            ImageRef(id: "L_MID", displayName: "L_MID", captureDate: date("2024-06-01T00:00:00Z"))
        ]
        let cloudA = [
            ImageRef(id: "C_NEWEST", displayName: "C_NEWEST", captureDate: date("2024-12-01T00:00:00Z")),
            ImageRef(id: "C_OLDEST", displayName: "C_OLDEST", captureDate: date("2024-01-01T00:00:00Z")),
        ]
        let cloudB = [
            ImageRef(id: "C_MID2", displayName: "C_MID2", captureDate: date("2024-06-15T00:00:00Z"))
        ]
        let merged = MergedTimelineSource.merge(
            localStreams: [photoKit], cloudStreams: [cloudA, cloudB])
        let ids = merged.map { MergedTimelineSource.renderID($0) }
        XCTAssertEqual(ids, ["C_NEWEST", "C_MID2", "L_MID", "C_OLDEST"])
    }

    /// A `nil` capture date sinks to the bottom, generalized across streams —
    /// preserves the pairwise tie/nil handling documented on `merge`.
    func testNWayNilCaptureDateSinksToBottomAcrossStreams() {
        let dated = ImageRef(id: "DATED", displayName: "DATED", captureDate: date("2024-06-01T00:00:00Z"))
        let undated = ImageRef(id: "UNDATED", displayName: "UNDATED")
        let merged = MergedTimelineSource.merge(
            localStreams: [[dated]], cloudStreams: [[undated], []])
        let ids = merged.map { MergedTimelineSource.renderID($0) }
        XCTAssertEqual(ids, ["DATED", "UNDATED"])
    }

    /// Regression: the pairwise `merge(local:cloud:)` wrapper must match the
    /// N-way engine bit-for-bit across every existing pairwise fixture,
    /// including precedence-sensitive multi-key cases.
    func testPairwiseWrapperMatchesNWayEngine() {
        let l1 = ImageRef(id: "P1", displayName: "P1", captureDate: date("2024-03-15T10:00:00Z"))
        let l2 = ImageRef(id: "B_PHID", displayName: "B_PHID", cloudIdentifier: "icloud-XYZ")
        let l3 = ImageRef(id: "A_PHID", displayName: "A_PHID")
        let c1 = ImageRef(id: "C1", displayName: "C1",
                          captureDate: date("2024-03-15T10:00:00Z"),
                          phassetLink: "P1")
        let c2 = ImageRef(id: "fs:/lib/a.heic", displayName: "a.heic",
                          phassetLink: "A_PHID",
                          cloudIdentifier: "icloud-XYZ",
                          allPhassetLinks: ["A_PHID"],
                          allCloudIdentifiers: ["icloud-XYZ"])
        let local = [l1, l2, l3]
        let cloud = [c1, c2]

        let pairwise = MergedTimelineSource.merge(local: local, cloud: cloud)
        let nway = MergedTimelineSource.merge(localStreams: [local], cloudStreams: [cloud])
        XCTAssertEqual(pairwise, nway)
        XCTAssertFalse(pairwise.isEmpty)
    }
}
