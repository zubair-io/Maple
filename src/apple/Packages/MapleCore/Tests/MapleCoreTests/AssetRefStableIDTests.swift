// AssetRefStableIDTests.swift — unit tests for AssetRef.stableID contract.
//
// Covers the contract introduced in #1410: filesystem-backed AssetRefs
// (built via `AssetRef(url:)`) now populate `stableID` with `url.path`
// so `maple://image/{id}` deep links can resolve local assets by path
// without an additional index lookup. These tests pin the behavior so a
// refactor cannot silently break deep linking.

import XCTest
@testable import MapleCore

final class AssetRefStableIDTests: XCTestCase {

    // MARK: - AssetRef(url:) — stableID = url.path

    func test_urlInit_setsStableIDToURLPath() {
        let url = URL(fileURLWithPath: "/Users/alice/Photos/IMG_0001.dng")
        let ref = AssetRef(url: url)
        XCTAssertEqual(ref.stableID, "/Users/alice/Photos/IMG_0001.dng",
                       "stableID must equal url.path for filesystem assets so deep links can resolve by path")
    }

    func test_urlInit_stableIDIsStable_acrossMultipleInits() {
        // Two AssetRefs built from the same URL must have the same stableID
        // (they get different `id` UUIDs, but stableID is content-stable).
        let url = URL(fileURLWithPath: "/Volumes/SSD/shoots/raw/dji-0042.dng")
        let ref1 = AssetRef(url: url)
        let ref2 = AssetRef(url: url)
        XCTAssertNotEqual(ref1.id, ref2.id,
                          "UUID identity differs per init by design")
        XCTAssertEqual(ref1.stableID, ref2.stableID,
                       "stableID must be the same for the same path — deep-link lookup is path-keyed")
    }

    func test_urlInit_withScopeParentURL_setsStableIDToURLPath() {
        // scopeParentURL must not affect stableID — the id is always the
        // file's own path, not the scope root.
        let url = URL(fileURLWithPath: "/Users/bob/Photos/portrait.cr3")
        let scope = URL(fileURLWithPath: "/Users/bob/Photos")
        let ref = AssetRef(url: url, scopeParentURL: scope)
        XCTAssertEqual(ref.stableID, "/Users/bob/Photos/portrait.cr3")
    }

    // MARK: - AssetRef(displayName:…) — stableID passed through

    func test_bytesProviderInit_stableIDIsPassedThrough() {
        let ref = AssetRef(
            displayName: "IMG_0042.heic",
            hintExtension: "heic",
            stableID: "maple:deadbeef1234",
            bytesProvider: { throw NSError(domain: "test", code: 0) }
        )
        XCTAssertEqual(ref.stableID, "maple:deadbeef1234")
    }

    func test_bytesProviderInit_withNilStableID_isNil() {
        let ref = AssetRef(
            displayName: "untitled.dng",
            hintExtension: "dng",
            stableID: nil,
            bytesProvider: { throw NSError(domain: "test", code: 0) }
        )
        XCTAssertNil(ref.stableID)
    }
}
