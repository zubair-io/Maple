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
}
