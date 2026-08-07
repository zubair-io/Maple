// AssetRenameAction.swift — environment action for inline single-asset
// rename (#2638).
//
// Delivered as an environment value (mirrors `RevealFolderAction` /
// `SearchTextAction`, #2518) so the Info panel's filename row and the
// Browse grid's Enter-key shortcut don't need explicit callback threading
// down through every intermediate view. SwiftUI does NOT propagate custom
// environment values across a `.sheet` / `.popover` / `.inspector` content
// boundary, so — exactly like those two actions — this must be re-injected
// at every such boundary that renders `InfoPanelView` (`PreviewView`'s
// inspector/sheet/popover, `EditorDestination`'s Info sheet).
//
// State (which asset — if any — is mid-rename, and the last error) travels
// alongside the action closures rather than as separate environment keys:
// the two are read together everywhere this is consumed (the filename row
// needs both "am I the one editing" and "what went wrong"), and bundling
// them means AppShell only has to rebuild one value per render instead of
// keeping several environment keys in sync.

import MapleCore
import SwiftUI

/// Snapshot of the rename affordance's state + actions for the current
/// render. Rebuilt each time `AppShell.body` evaluates (mirrors
/// `RevealFolderAction`'s per-render closure capture) — cheap, and keeps
/// every consumer reading the SAME state `AppShell` just committed rather
/// than a stale copy from an earlier render.
struct AssetRenameContext {
  /// The asset currently in edit mode, if any. A filename row compares this
  /// against its own asset's `id` to decide whether to render the static
  /// label or the editable field.
  let renamingAssetID: AssetRef.ID?
  /// Set when the last `commit` attempt failed — cleared on the next
  /// `begin`/`commit` call. Surfaced inline next to the field, never as a
  /// generic alert (ticket requirement).
  let errorText: String?
  /// `nil` when `asset` supports rename; otherwise the user-facing reason
  /// it's disabled (PhotoKit has no user-writable path — design doc: surface
  /// WHY rather than silently hiding or failing).
  let unsupportedReason: @MainActor (AssetRef) -> String?
  let begin: @MainActor (AssetRef) -> Void
  let cancel: @MainActor () -> Void
  /// `newFilename` is the full desired filename (stem + extension) — the
  /// caller has already resolved any extension-change confirmation before
  /// calling this.
  let commit: @MainActor (AssetRef, String) -> Void

  /// Convenience for a filename row: is `asset` the one currently editing?
  @MainActor func isRenaming(_ asset: AssetRef) -> Bool {
    renamingAssetID == asset.id
  }
}

private struct AssetRenameContextKey: EnvironmentKey {
  static let defaultValue: AssetRenameContext? = nil
}

extension EnvironmentValues {
  var assetRename: AssetRenameContext? {
    get { self[AssetRenameContextKey.self] }
    set { self[AssetRenameContextKey.self] = newValue }
  }
}
