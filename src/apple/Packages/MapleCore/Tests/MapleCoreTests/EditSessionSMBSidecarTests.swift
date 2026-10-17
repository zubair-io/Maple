// EditSessionSMBSidecarTests.swift — regression coverage for #2674:
// SMB-sourced edits were never persisted because `EditSession` never had a
// `SidecarStoreProtocol` wired for `.smb`-provenance assets.
//
// Root cause (see the ticket + `docs/architecture.md`'s sidecar-location
// table): `SMBSource.images()` deliberately builds every `ImageRef` with
// `url: nil` (the Rust decoder can't open an `smb://` URL), so SMB assets
// are sourceless. Before this fix, `BrowseViewModel.loadSource`'s
// sourceless branch never tagged these refs with any `thumbnailProvenance`
// (unlike the PhotoKit paging path, which always sets `.photoKit`), so
// `AppShell+FolderActions.ensureSession`'s per-provenance switch fell to its
// `nil` case — a fallback gated on `librarySelection == .cloudLibrary(...)`,
// which SMB browsing never sets (it sets `.smbShare`). `remoteStore` ended
// up `nil`, `EditSession.init` (no `primaryURL`, no `remoteSidecarStore`)
// fell to `sidecarStore = nil`, and every subsequent `model`/`culling`
// `didSet`'s `if let store = sidecarStore { … }` guard was a silent no-op.
//
// The fix: `BrowseViewModel.loadSource` now tags SMB-sourced refs with the
// new `.smb` provenance case, and `ensureSession` resolves it to a real
// `SMBSidecarStore` built from the browse session's already-connected
// `SMBSource` actor. These tests build the `EditSession` the same way
// `ensureSession`'s new `.smb` branch does and prove an edit reaches the
// real write path — mirrors `EditSessionPhotoKitSidecarTests.swift`'s shape
// for the #2555 PhotoKit fix.
//
// No live SMB server exists in this repo (see `SMBSourceSidecarTests.swift`
// for the same documented constraint), so these tests prove the edit
// reaches a REAL `SMBSidecarStore` → REAL `SMBSource` write attempt (which
// then deterministically fails with `.notConnected` against an unconnected
// source) rather than a full write→reconnect→read round trip. Before the
// fix this was categorically impossible to observe: `sidecarStore` was
// `nil`, so nothing was ever attempted at all — an unconnected write
// failing is proof of a REAL attempt; a silently-dropped edit produces no
// error whatsoever, which is exactly the bug.

import XCTest
@testable import MapleCore

@MainActor
final class EditSessionSMBSidecarTests: XCTestCase {

    /// A sourceless `AssetRef` mirroring exactly what
    /// `BrowseViewModel.loadSource`'s sourceless branch now builds for an
    /// `SMBSource` — `.smb` provenance, `stableID` carrying the maple_id.
    ///
    /// The `stableID`/`ref.id` values these tests pass in (e.g.
    /// `"smb-share/Photos/IMG_2674.dng"`) are path-shaped, not real maple_id
    /// hex — deliberately so, and not a bug: `SMBSource.path(for:)`
    /// (`pathByMapleId[ref.id] ?? ref.id`) falls back to treating `ref.id`
    /// itself as the share path whenever there's no `pathByMapleId` entry,
    /// which is exactly this test's setup (a fresh, never-`images()`'d
    /// `SMBSource`). Production hits that same fallback branch, not just
    /// this test, whenever maple_id derivation genuinely fails for an asset
    /// (`images()`'s `mapleId(for:) ?? a.path`) — so a path-shaped id here
    /// exercises a real, if rare, production code path rather than standing
    /// in for one. It's also incidental to what these tests assert: the
    /// `.notConnected` failure they check for comes from the `guard let
    /// client` checks in `SMBSource`'s I/O methods, which fire before
    /// `path(for:)`'s result is ever used for a network call — so the id's
    /// shape has no bearing on whether these tests pass. A real maple_id hex
    /// would exercise the same paths identically.
    private func smbAssetRef(stableID: String) -> AssetRef {
        AssetRef(
            displayName: "IMG_SMB_TEST.dng",
            hintExtension: "dng",
            stableID: stableID,
            thumbnailProvenance: .smb,
            bytesProvider: {
                throw NSError(domain: "test", code: -1)
            })
    }

    /// Builds the same `SMBSidecarStore` shape `ensureSession`'s `.smb`
    /// branch constructs: a fresh (unconnected) `SMBSource` — standing in
    /// for the browse session's live connection, which cannot be
    /// established without a real share — and an `ImageRef` carrying the
    /// asset's maple_id (see `smbAssetRef` above for why these tests use
    /// path-shaped stand-in values rather than real maple_id hex).
    private func smbSidecarStore(stableID: String) -> SMBSidecarStore {
        let source = SMBSource()
        let ref = ImageRef(id: stableID, displayName: "IMG_SMB_TEST.dng")
        return SMBSidecarStore(source: source, ref: ref)
    }

    /// The core regression assertion PR #2675's contract suite documented
    /// with `XCTExpectFailure` (`testEditSessionDoesNotPersistEditsForSMBSourcedAssets`):
    /// an SMB-sourced `EditSession`, wired the way production code now wires
    /// it, must have a REAL sidecar store — not `nil`. Unlike that upstream
    /// test (which built the asset with `thumbnailProvenance: nil`, "exactly
    /// what SMB browsing produces today" AT THE TIME IT WAS WRITTEN), this
    /// asserts against the POST-FIX shape: `.smb` provenance +
    /// `ensureSession`'s new `SMBSidecarStore(source:ref:)` construction.
    func testSMBSourcedEditSessionHasARealSidecarStore() async throws {
        let asset = smbAssetRef(stableID: "smb-share/Photos/IMG_2674.dng")
        let store = smbSidecarStore(stableID: "smb-share/Photos/IMG_2674.dng")

        let session = EditSession(asset: asset, remoteSidecarStore: store)

        XCTAssertNotNil(
            session.sidecarStore,
            "an SMB-sourced EditSession must have a real sidecar store wired, "
                + "or every edit to an SMB-sourced photo is silently lost on session teardown")
    }

    /// A model edit on an SMB-sourced session must reach the wired
    /// `SMBSidecarStore` rather than vanish (#2674). The store's share is
    /// never connected here, so the session's read of the sidecar fails with
    /// `SMBError.notConnected` — proof the real store was reached — and the
    /// session stays read-only (#4708): the edit is refused, not written over
    /// a sidecar it could not read.
    func testEditOnAnUnreachableShareIsRefusedNotSilentlyDropped() async throws {
        let stableID = "smb-share/Photos/IMG_2674-b.dng"
        let asset = smbAssetRef(stableID: stableID)
        let store = smbSidecarStore(stableID: stableID)
        let session = EditSession(asset: asset, remoteSidecarStore: store)

        await session.loadSidecar()
        session.model.exposure = 1.75
        await session.flushPendingSidecarWrite()

        XCTAssertTrue(session.sidecarLoadFailed)
        XCTAssertFalse(session.hasLoadedSidecar)
        let received = try XCTUnwrap(session.sidecarError)
        guard case .notConnected = received as? SMBError else {
            return XCTFail("expected SMBError.notConnected, got \(received)")
        }
    }

    /// `flushPendingSidecarWrite()` must reach the SMB store immediately,
    /// not wait on the 750ms debounce — the gap an old `as?` typecast chain
    /// left for SMB sessions (#2674 review). A rating queued before the
    /// sidecar loaded makes the flush hydrate through the store first, so
    /// the unconnected share's `.notConnected` must surface well inside a
    /// window shorter than the debounce.
    func testFlushReachesTheSMBStoreBeforeDebounceFires() async throws {
        let stableID = "smb-share/Photos/IMG_2674-c.dng"
        let asset = smbAssetRef(stableID: stableID)
        let store = smbSidecarStore(stableID: stableID)
        let session = EditSession(asset: asset, remoteSidecarStore: store)

        session.culling.stars = 4
        let started = Date()
        await session.flushPendingSidecarWrite()

        XCTAssertLessThan(Date().timeIntervalSince(started), 0.3)
        let received = try XCTUnwrap(
            session.sidecarError,
            "flushPendingSidecarWrite() never reached the SMB store")
        guard case .notConnected = received as? SMBError else {
            return XCTFail("expected SMBError.notConnected, got \(received)")
        }
    }
}
