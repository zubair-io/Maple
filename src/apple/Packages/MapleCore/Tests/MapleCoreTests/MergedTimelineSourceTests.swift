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
}
