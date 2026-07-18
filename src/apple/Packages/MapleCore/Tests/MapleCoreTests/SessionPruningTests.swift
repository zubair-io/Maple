// SessionPruningTests.swift — the "prune to a keep-set" primitive behind
// AppShell's two session-eviction call sites (#2038):
//   • pruneInactiveSessions      — editor-open / active-asset switch
//   • pruneSessionsForNewAssetList — folder / library navigation
//
// Both reduce to "here is the set of asset ids that must stay resident";
// `prunedSessions(_:keeping:)` (EditSession+SessionPruning.swift) does the
// actual dictionary filter. These tests exercise that filter directly
// against real `EditSession` instances, the same way EditSessionDecodedCacheTests
// and friends synthesize a temp file for `AssetRef(url:)`.

import XCTest
@testable import MapleCore

@MainActor
final class SessionPruningTests: XCTestCase {

    // MARK: - Helpers

    /// Synthesise a temp `.dng` so `AssetRef(url:)` has a real file path to
    /// key against. Bytes don't matter — `prunedSessions` never touches the
    /// render pipeline, only the dictionary's keys.
    private func makeAsset(named name: String) throws -> (asset: AssetRef, dir: URL) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("\(name).dng")
        try Data([0x44, 0x4E, 0x47]).write(to: url)
        return (AssetRef(url: url), dir)
    }

    func testPrunedSessionsKeepsOnlyIDsInTheKeepSet() throws {
        let (assetA, dirA) = try makeAsset(named: "a")
        let (assetB, dirB) = try makeAsset(named: "b")
        let (assetC, dirC) = try makeAsset(named: "c")
        defer {
            try? FileManager.default.removeItem(at: dirA)
            try? FileManager.default.removeItem(at: dirB)
            try? FileManager.default.removeItem(at: dirC)
        }

        let sessions: [AssetRef.ID: EditSession] = [
            assetA.id: EditSession(asset: assetA),
            assetB.id: EditSession(asset: assetB),
            assetC.id: EditSession(asset: assetC),
        ]

        let kept = prunedSessions(sessions, keeping: [assetB.id])

        XCTAssertEqual(kept.count, 1)
        XCTAssertNotNil(kept[assetB.id])
        XCTAssertNil(kept[assetA.id])
        XCTAssertNil(kept[assetC.id])
    }

    /// Mirrors the folder-navigation call site: the keep-set is the newly-
    /// loaded folder's whole asset list (plus, separately, an open-editor id
    /// — covered by the next test). Nothing outside that list survives.
    func testPrunedSessionsKeepsEveryIDInAMultiElementKeepSet() throws {
        let (assetA, dirA) = try makeAsset(named: "a")
        let (assetB, dirB) = try makeAsset(named: "b")
        let (assetC, dirC) = try makeAsset(named: "c")
        defer {
            try? FileManager.default.removeItem(at: dirA)
            try? FileManager.default.removeItem(at: dirB)
            try? FileManager.default.removeItem(at: dirC)
        }

        let sessions: [AssetRef.ID: EditSession] = [
            assetA.id: EditSession(asset: assetA),
            assetB.id: EditSession(asset: assetB),
        ]

        let kept = prunedSessions(sessions, keeping: [assetA.id, assetB.id, assetC.id])

        XCTAssertEqual(kept.count, 2)
        XCTAssertNotNil(kept[assetA.id])
        XCTAssertNotNil(kept[assetB.id])
    }

    /// Mirrors `pruneInactiveSessions`'s "active asset isn't resident yet"
    /// branch, and the folder-navigation prune when the new folder is empty
    /// and no editor is open — the whole dictionary is dropped.
    func testPrunedSessionsDropsEverythingWhenKeepSetIsEmpty() throws {
        let (assetA, dir) = try makeAsset(named: "a")
        defer { try? FileManager.default.removeItem(at: dir) }

        let sessions: [AssetRef.ID: EditSession] = [assetA.id: EditSession(asset: assetA)]

        let kept = prunedSessions(sessions, keeping: [])

        XCTAssertTrue(kept.isEmpty)
    }

    func testPrunedSessionsIsANoOpWhenEverySessionIsAlreadyInTheKeepSet() throws {
        let (assetA, dir) = try makeAsset(named: "a")
        defer { try? FileManager.default.removeItem(at: dir) }

        let sessions: [AssetRef.ID: EditSession] = [assetA.id: EditSession(asset: assetA)]

        let kept = prunedSessions(sessions, keeping: [assetA.id])

        XCTAssertEqual(kept.count, 1)
        XCTAssertNotNil(kept[assetA.id])
    }
}
