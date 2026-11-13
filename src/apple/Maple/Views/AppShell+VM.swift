// AppShell+VM.swift — pure-function view-model helpers for AppShell.
//
// Pattern (issue #192): a SwiftUI view with non-trivial derivation gets a
// sibling `+VM.swift` whose contents are unit-testable in isolation
// (`AppShellVMTests` in the MapleTests target). To preserve that guarantee
// this file MUST NOT `import SwiftUI`. `AppShell.Mode` is a plain nested
// enum, so referencing it here needs nothing from SwiftUI.

import Foundation
import MapleCore

// MARK: - AppShellVM

/// Namespace for pure AppShell derivations. A caseless enum keeps the
/// helpers grouped without ever being instantiated. All members are static.
enum AppShellVM {

  // MARK: - Filmstrip landing surface (#3402)

  /// The pane-shell mode after a filmstrip tap while `mode` is on screen.
  ///
  /// A filmstrip belongs to the surface that hosts it, so tapping a
  /// sibling stays on that surface: the editor's rail keeps `.editing`
  /// (the user is mid-edit and wants the next photo in the same editor),
  /// Preview's rail keeps `.preview`. Neither routes through
  /// `AppShell.imageOpenMode` — that is the grid-tap / deep-link landing
  /// (`.preview`), and sending an editor-rail tap through it is exactly
  /// the bug #3402 fixes (every sibling pick silently dropped the user
  /// out of the editor).
  ///
  /// Off an image surface no filmstrip is mounted; a tap that still
  /// arrives (a callback firing after the surface was dismissed) lands
  /// where any other open would — Preview.
  static func filmstripLandingMode(hosting mode: AppShell.Mode) -> AppShell.Mode {
    switch mode {
    case .editing, .preview: return mode
    case .browse, .panoramaMerge: return .preview
    }
  }

  // MARK: - Session bookkeeping

  /// The `EditSession` an in-place selection (deep link, document open,
  /// filmstrip sibling) edits against: the one the grid already primed
  /// (`AppShell.ensureSession(for:)` on cell appear) when present,
  /// otherwise a fresh one cached into `sessions` so the grid badges and
  /// a later editor open share the same instance. `created` tells the
  /// caller a sidecar load is still owed — kept out of here so the helper
  /// stays synchronous, with no side effect beyond the dictionary write.
  ///
  /// `remoteStore` and `remotePreviewSink` are the caller's source-aware
  /// sidecar store and display-preview sink resolvers
  /// (`AppShell.remoteSidecarStore(for:)` / `remotePreviewSink(for:)`),
  /// consulted only when a session is actually created. Without them a
  /// Cloud / PhotoKit / SMB asset (no `primaryURL`) got a session with no
  /// store or preview destination, so every edit on a filmstrip sibling was
  /// session-local (#4712) and cloud browse-primed edits never refreshed
  /// the server's `<filename>.avif` preview (#4846).
  @MainActor
  static func ensureSession(
    for asset: AssetRef,
    in sessions: inout [AssetRef.ID: EditSession],
    remoteStore: () -> (any SidecarStoreProtocol)?,
    remotePreviewSink: () -> (any DisplayPreviewSink)? = { nil }
  ) -> (session: EditSession, created: Bool) {
    if let existing = sessions[asset.id] { return (existing, false) }
    // FileProvider observer drives the progress on Files-app picks;
    // local files never call begin() and stay overlay-free.
    let session = EditSession(
      asset: asset,
      remoteSidecarStore: remoteStore(),
      remotePreviewSink: remotePreviewSink(),
      downloadProgress: DownloadProgress())
    sessions[asset.id] = session
    return (session, true)
  }

  // MARK: - Cloud session resolution (#4846)

  /// Canonical owning server for a cloud-backed `AssetRef`, or `nil` when
  /// the ref belongs to a local file, PhotoKit, SMB, or no cloud context.
  ///
  /// Precedence (#2299, #4712, #4846):
  ///   1. Explicit `.cloud(server:)` provenance (Timeline / Search folder siblings).
  ///   2. `.photoKit` / `.smb` provenance is never cloud, even when the ambient
  ///      library selection still names a cloud library.
  ///   3. `catalog?.serverID` (refs built by `BrowseViewModel.loadCloudDir` or
  ///      `prepareCloudSession`).
  ///   4. Fallback to the ambient `.cloudLibrary` server when provenance and
  ///      catalog are both absent.
  static func cloudServer(
    for asset: AssetRef,
    ambientServer: () -> URL? = { nil }
  ) -> URL? {
    guard asset.primaryURL == nil else { return nil }
    switch asset.thumbnailProvenance {
    case .cloud(let server):
      return server
    case .photoKit, .smb:
      return nil
    case nil:
      return asset.catalog?.serverID ?? ambientServer()
    }
  }

  /// Server-side absolute path for a cloud-backed `AssetRef` (`PUT /api/preview?path=…`).
  /// Prefers `catalog.absPath` (populated by `BrowseViewModel.loadCloudDir`,
  /// `prepareCloudSession`, and updated on rename by `AssetRef.renamedCloud`),
  /// falling back to stripping the `fs:` prefix from `stableID`.
  static func cloudAssetPath(for asset: AssetRef) -> String? {
    guard asset.primaryURL == nil else { return nil }
    if let absPath = asset.catalog?.absPath, !absPath.isEmpty {
      return absPath
    }
    guard let stableID = asset.stableID, stableID.hasPrefix("fs:") else {
      return nil
    }
    let path = String(stableID.dropFirst(3))
    return path.isEmpty ? nil : path
  }

  // MARK: - Search Preview sibling splice (#3551)

  /// Put the asset the user actually TAPPED into its containing folder's
  /// sibling list at its own position. The list entries are lazily built
  /// refs with fresh `AssetRef.id`s, so the match is by catalog path (what
  /// a folder listing knows) and then by `stableID` (both sides carry the
  /// `fs:<absPath>` id). Without the splice the shown asset would not be
  /// found BY ID in its own list — no filmstrip highlight, no prev/next.
  /// Falls back to `[tapped]` when the folder does not contain it (the tap
  /// raced a move or the listing failed) rather than risk a mismatched
  /// swipe domain.
  static func splicingTappedAsset(_ tapped: AssetRef, into siblings: [AssetRef]) -> [AssetRef] {
    let index = siblings.firstIndex { sibling in
      if let path = tapped.catalog?.absPath, sibling.catalog?.absPath == path { return true }
      return tapped.stableID != nil && sibling.stableID == tapped.stableID
    }
    guard let index else { return [tapped] }
    var spliced = siblings
    spliced[index] = tapped
    return spliced
  }
}
