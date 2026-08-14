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

    /// A model edit (exposure slider) made through `EditSession.model` —
    /// exactly what a real slider drag does — must reach the wired
    /// `SMBSidecarStore` and attempt a real SMB write. Proven here by the
    /// write's deterministic failure (`SMBError.notConnected`, the source
    /// was never connected) surfacing through `session.sidecarError` — the
    /// same propagation path #1412 wired for every other adapter. Before
    /// #2674 there was no store to attempt anything with, so this error
    /// could never have appeared; its appearance IS the proof the edit is
    /// no longer silently dropped.
    func testModelEditRoutesThroughSMBSidecarStoreAndAttemptsARealWrite() async throws {
        let stableID = "smb-share/Photos/IMG_2674-b.dng"
        let asset = smbAssetRef(stableID: stableID)
        let store = smbSidecarStore(stableID: stableID)
        let session = EditSession(asset: asset, remoteSidecarStore: store)

        var edited = session.model
        edited.exposure = 1.75
        session.model = edited

        // `model`'s didSet spawns a detached Task calling `store.update(...)`
        // — yield so it actually runs before we flush (mirrors
        // EditSessionPhotoKitSidecarTests / EditSessionTests conventions).
        for _ in 0..<5 { await Task.yield() }
        await session.flushPendingSidecarWrite()

        // Poll for the error to hop from the actor onto MainActor — mirrors
        // EditSessionTests.testSidecarWriteErrorPropagatesFromStoreThroughSession.
        let deadline = Date().addingTimeInterval(2.0)
        while Date() < deadline {
            if session.sidecarError != nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }

        let received = try XCTUnwrap(
            session.sidecarError,
            "the slider edit never reached a real SMB write attempt — "
                + "it was silently dropped, reproducing #2674")
        guard case .notConnected = received as? SMBError else {
            return XCTFail("expected SMBError.notConnected, got \(received)")
        }
    }

    /// Distinguishes an explicit `flushPendingSidecarWrite()` from the
    /// 750ms debounce timer firing on its own. `testModelEditRoutesThrough-
    /// SMBSidecarStoreAndAttemptsARealWrite` above polls for up to 2s —
    /// longer than `SMBSidecarStore.debounceInterval` — so it passes
    /// whether or not the explicit flush does anything: the debounce timer
    /// alone would eventually fire and write within that window. That's
    /// exactly the gap `EditSession+Lifecycle.swift`'s `flushPending-
    /// SidecarWrite()` fell into: its `as?` typecast chain covered
    /// `XMPSidecarStore`/`PhotoKitSidecarStore`/`CloudSidecarStore` but not
    /// `SMBSidecarStore`, so for SMB sessions the "explicit flush" was a
    /// silent no-op and every edit made within the debounce window before
    /// tearing the editor down was dropped — the exact class of bug #2674
    /// exists to fix, resurfacing at teardown.
    ///
    /// This test polls only up to 300ms — well under the 750ms debounce —
    /// immediately after calling `flushPendingSidecarWrite()`. `SMBSource`'s
    /// `.notConnected` guard (`guard let client else { throw
    /// SMBError.notConnected }`) is a synchronous check with no network
    /// round trip, so if the explicit flush actually reaches
    /// `SMBSidecarStore.flush()` the error surfaces almost instantly; if the
    /// flush silently no-ops, nothing appears within 300ms and only the
    /// (untested-here) 750ms timer would eventually produce it. A window
    /// shorter than the debounce interval is the only way to tell "the
    /// explicit flush worked" apart from "the timer happened to fire on its
    /// own" — which is what makes this test able to actually fail against
    /// the unfixed `as?` chain.
    func testFlushPendingSidecarWriteForcesImmediateWriteBeforeDebounceFires() async throws {
        let stableID = "smb-share/Photos/IMG_2674-c.dng"
        let asset = smbAssetRef(stableID: stableID)
        let store = smbSidecarStore(stableID: stableID)
        let session = EditSession(asset: asset, remoteSidecarStore: store)

        var edited = session.model
        edited.exposure = 1.75
        session.model = edited

        // `model`'s didSet spawns a detached Task calling `store.update(...)`
        // — yield so it actually runs before we flush (mirrors
        // EditSessionPhotoKitSidecarTests / EditSessionTests conventions).
        for _ in 0..<5 { await Task.yield() }
        await session.flushPendingSidecarWrite()

        // Poll for a window strictly shorter than SMBSidecarStore's 750ms
        // debounce interval. Unlike the 2s poll above, this window cannot
        // be satisfied by the debounce timer firing on its own — only an
        // explicit flush that actually reaches the store can land here.
        let deadline = Date().addingTimeInterval(0.3)
        while Date() < deadline {
            if session.sidecarError != nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }

        let received = try XCTUnwrap(
            session.sidecarError,
            "flushPendingSidecarWrite() did not force an immediate SMB write "
                + "attempt within a window shorter than the 750ms debounce — "
                + "the SMB store is being silently skipped by the flush's "
                + "as? typecast chain")
        guard case .notConnected = received as? SMBError else {
            return XCTFail("expected SMBError.notConnected, got \(received)")
        }
    }
}
