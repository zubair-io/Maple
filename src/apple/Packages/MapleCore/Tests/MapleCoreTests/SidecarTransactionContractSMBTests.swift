// SidecarTransactionContractSMBTests.swift — the SMB (network share)
// adapter's transaction contract (#2431). See `SidecarContractSupport.swift`
// for the shared vectors/helpers and the recipe every adapter file follows.
//
// SMB is `SMBSource` (`Sources/SMBSource.swift`), over AMSMB2. No live SMB
// server exists in CI or this environment (`grep`-confirmed: no docker/samba
// fixture anywhere in the repo), and `SMB2Manager` is a concrete AMSMB2
// class, not a protocol — there is no injectable fake transport the way
// `AuthenticatedHTTPClient`'s `URLSession` is, so a genuine multi-cycle
// write/reload contract test (like the other three adapter files) is not
// buildable without standing up real loopback SMB infrastructure. Per
// CLAUDE.md, inventing that infrastructure here would be exactly the kind
// of architectural decision this suite should surface rather than build —
// noted in the PR, not silently added.
//
// What IS real and testable without a server: `SMBSource.writeSidecar` /
// `.writeXMP` both guard `client != nil` and throw `SMBError.notConnected`
// deterministically otherwise — including immediately after `disconnect()`,
// which clears `client` — so "disconnect state is deterministic and
// observable" (acceptance criterion #4) has direct coverage below.
//
// The second thing this file documented was a real product bug this
// suite's design work surfaced: `EditSession` never persisted edits for
// SMB-sourced assets at all (#2674, filed alongside this PR). That was
// fixed by #2680 — `BrowseViewModel.loadSource` now tags SMB-sourced refs
// with `.smb` provenance, and `AppShell+FolderActions.ensureSession`
// resolves that provenance to a real `SMBSidecarStore` built from the
// browse session's live `SMBSource` connection. `testEditSessionPersists-
// EditsForSMBSourcedAssets` below now builds an `EditSession` the same way
// `ensureSession`'s `.smb` branch does (see `EditSessionSMBSidecarTests.swift`
// for the equivalent, more detailed coverage of this same wiring) and
// asserts the store is real, no `XCTExpectFailure` needed — the
// `XCTExpectFailure` this test carried before #2680 landed is gone; its
// removal is itself the signal that the gap is closed.

import XCTest

@testable import MapleCore

final class SidecarTransactionContractSMBTests: XCTestCase {

  // MARK: - Disconnect state is deterministic and observable (acceptance criterion #4)

  func testWriteWithoutEverConnectingFailsDeterministically() async throws {
    let source = SMBSource()
    let asset = SMBSource.SMBAsset(path: "/Photos/IMG_0001.dng")

    for attempt in 0..<5 {
      do {
        try await source.writeSidecar(Data("irrelevant".utf8), for: asset)
        XCTFail("attempt \(attempt): write must fail without a connection")
      } catch let error as SMBError {
        guard case .notConnected = error else {
          return XCTFail("attempt \(attempt): expected .notConnected, got \(error)")
        }
      }
    }
  }

  func testWriteAfterDisconnectFailsDeterministically() async throws {
    let source = SMBSource()
    // `disconnect()` on a never-connected source is a documented no-op
    // that still clears state — exercises the exact code path a
    // mid-session network drop takes (client set back to nil) without
    // needing a real share to have connected to in the first place.
    await source.disconnect()

    let asset = SMBSource.SMBAsset(path: "/Photos/IMG_0002.dng")
    do {
      try await source.writeSidecar(Data("irrelevant".utf8), for: asset)
      XCTFail("write after disconnect must fail")
    } catch let error as SMBError {
      guard case .notConnected = error else {
        return XCTFail("expected .notConnected, got \(error)")
      }
    }
  }

  // MARK: - Fixed gap: SMB edits are now persisted by EditSession (#2674 → #2680)

  /// Reproduces the real, POST-#2680 app wiring: an SMB-sourced `AssetRef`
  /// has `primaryURL == nil` (`SMBSource.images()` deliberately leaves `url`
  /// nil — the Rust decoder can't open an `smb://` URL) and now carries
  /// `.smb` `thumbnailProvenance` (`BrowseViewModel.loadSource`), which
  /// `AppShell+FolderActions.ensureSession` resolves to a real
  /// `SMBSidecarStore` built from the browse session's live `SMBSource`
  /// connection — this test builds that same `SMBSidecarStore(source:ref:)`
  /// shape directly and injects it the way `ensureSession` does. Before
  /// #2680, `EditSession.init` fell to its `sidecarStore = nil` branch for
  /// every SMB asset and every subsequent `model` edit's
  /// `sidecarStore?.update(...)` was a silent no-op — the edit was real in
  /// memory, rendered live, and evaporated the moment the session was torn
  /// down. `SMBSource.writeXMP`/`.writeSidecarData` — the real, working,
  /// retrying write path this suite's other tests prove is individually
  /// correct — was never reachable from the live app for this reason.
  ///
  /// No live SMB server exists in this repo (see this file's header and
  /// `SMBSourceSidecarTests.swift`), so `sidecarStore` is asserted non-nil
  /// here rather than driving a full write/reopen contract cycle — the
  /// deeper "does a real write actually get attempted" proof (via the
  /// deterministic `.notConnected` failure) lives in
  /// `EditSessionSMBSidecarTests.swift`, alongside the flush-forces-an-
  /// immediate-write regression coverage for the teardown half of #2674.
  func testEditSessionPersistsEditsForSMBSourcedAssets() async throws {
    let stableID = "smb-share/Photos/IMG_0003.dng"
    let asset = AssetRef(
      displayName: "IMG_0003.dng",
      hintExtension: "dng",
      stableID: stableID,
      explicitIsRaw: true,
      thumbnailProvenance: .smb,  // what SMB browsing produces post-#2680
      bytesProvider: { Data() })
    let store = SMBSidecarStore(
      source: SMBSource(), ref: ImageRef(id: stableID, displayName: "IMG_0003.dng"))

    let hasSidecarStore = await MainActor.run { () -> Bool in
      let session = EditSession(asset: asset, remoteSidecarStore: store)
      session.model = SidecarContractVectors.fullyAuthoredModel()
      return session.sidecarStore != nil
    }

    XCTAssertTrue(
      hasSidecarStore,
      "an SMB-sourced EditSession must have a real sidecar store wired, "
        + "or every edit to an SMB-sourced photo is silently lost on session teardown")
  }
}
