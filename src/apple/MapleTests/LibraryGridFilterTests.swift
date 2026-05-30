// LibraryGridFilterTests.swift — pure-logic coverage for the
// `LibraryGrid.applyFilter` reducer (responsive-program S2, #623).
//
// The reducer is `static func applyFilter(_:to:sessions:)` on
// `LibraryGrid`. It maps a `cm.filter` string + asset list + lazy
// `[id: EditSession]` map to a filtered asset list. Because culling
// state lives on `EditSession` and sessions are primed lazily as
// cells appear, the reducer's contract is: "filter against whatever
// sessions are currently primed". That trade-off is exercised here
// alongside the trivial "all" / "picks" / "4stars" cases.
//
// The "edited" filter (#628) checks `AssetRef.hasEdits` — the URL-based
// sidecar-existence predicate. The test stages a temp directory with
// a real `.xmp` next to one asset and asserts the filter keeps only
// that one.

#if os(iOS)

import XCTest
import MapleCore
@testable import Maple_Exposure

final class LibraryGridFilterTests: XCTestCase {

    // MARK: - Helpers

    private func makeAsset(_ name: String) -> AssetRef {
        AssetRef(displayName: name,
                 hintExtension: "dng",
                 stableID: "stable-\(name)",
                 bytesProvider: nil)
    }

    private func makeSession(for asset: AssetRef,
                             stars: Int = 0,
                             flag: CullFlag = .none) -> EditSession {
        EditSession(asset: asset,
                    model: .default,
                    culling: CullingState(stars: stars, flag: flag))
    }

    // MARK: - "all"

    func testAllFilterReturnsEveryAsset() {
        let assets = [makeAsset("a"), makeAsset("b"), makeAsset("c")]
        let result = LibraryGrid.applyFilter("all", to: assets, sessions: [:])
        XCTAssertEqual(result.map(\.displayName), ["a", "b", "c"])
    }

    func testUnknownFilterFallsBackToAll() {
        let assets = [makeAsset("a"), makeAsset("b")]
        let result = LibraryGrid.applyFilter("garbage", to: assets, sessions: [:])
        XCTAssertEqual(result.count, 2)
    }

    // MARK: - "picks"

    func testPicksFilterKeepsOnlyPicks() {
        let a1 = makeAsset("picked")
        let a2 = makeAsset("unflagged")
        let a3 = makeAsset("rejected")
        let sessions: [AssetRef.ID: EditSession] = [
            a1.id: makeSession(for: a1, flag: .pick),
            a2.id: makeSession(for: a2, flag: .none),
            a3.id: makeSession(for: a3, flag: .reject),
        ]
        let result = LibraryGrid.applyFilter(
            "picks",
            to: [a1, a2, a3],
            sessions: sessions
        )
        XCTAssertEqual(result.map(\.displayName), ["picked"])
    }

    func testPicksFilterDropsAssetsWithoutSessions() {
        // Lazy-prime behaviour: an asset whose cell hasn't appeared on
        // screen has no session in the dict, so it can't match a
        // picks-only filter. Documented limitation; PR body calls this
        // out.
        let a1 = makeAsset("a")
        let result = LibraryGrid.applyFilter("picks", to: [a1], sessions: [:])
        XCTAssertTrue(result.isEmpty)
    }

    // MARK: - "4stars"

    func testFourStarsFilterKeepsRatingsFourOrAbove() {
        let a3 = makeAsset("3star")
        let a4 = makeAsset("4star")
        let a5 = makeAsset("5star")
        let sessions: [AssetRef.ID: EditSession] = [
            a3.id: makeSession(for: a3, stars: 3),
            a4.id: makeSession(for: a4, stars: 4),
            a5.id: makeSession(for: a5, stars: 5),
        ]
        let result = LibraryGrid.applyFilter(
            "4stars",
            to: [a3, a4, a5],
            sessions: sessions
        )
        XCTAssertEqual(result.map(\.displayName), ["4star", "5star"])
    }

    func testFourStarsFilterTreatsMissingSessionAsZeroStars() {
        // No session → no culling state → 0 stars → excluded.
        let a4 = makeAsset("4star")
        let aNone = makeAsset("unprimed")
        let sessions: [AssetRef.ID: EditSession] = [
            a4.id: makeSession(for: a4, stars: 4),
        ]
        let result = LibraryGrid.applyFilter(
            "4stars",
            to: [a4, aNone],
            sessions: sessions
        )
        XCTAssertEqual(result.map(\.displayName), ["4star"])
    }

    // MARK: - "edited"

    func testEditedFilterKeepsAssetsWithSidecar() throws {
        // Stage two URL-based assets in a temp dir; write a `.xmp`
        // next to ONE of them. The filter should keep only that one.
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("maple-edited-filter-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let editedURL = tempDir.appendingPathComponent("IMG_0001.dng")
        let plainURL = tempDir.appendingPathComponent("IMG_0002.dng")
        // Touch primary URLs (don't need real RAW bytes — only sidecar
        // existence is checked).
        try Data().write(to: editedURL)
        try Data().write(to: plainURL)
        // Stage the `.xmp` sidecar next to the edited asset only.
        try Data("<x:xmpmeta/>".utf8)
            .write(to: editedURL.deletingPathExtension().appendingPathExtension("xmp"))

        let edited = AssetRef(url: editedURL)
        let plain = AssetRef(url: plainURL)

        let result = LibraryGrid.applyFilter(
            "edited",
            to: [edited, plain],
            sessions: [:]
        )
        XCTAssertEqual(result.map(\.id), [edited.id])
    }

    func testEditedFilterExcludesURLLessRefs() {
        // PhotoKit / network refs have no sidecar URL to check — the
        // v0.1 contract is "URL-less refs never appear in 'edited'".
        let urlLess = makeAsset("photokit-asset")
        let result = LibraryGrid.applyFilter("edited", to: [urlLess], sessions: [:])
        XCTAssertTrue(result.isEmpty)
    }
}

#endif
