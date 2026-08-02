// AppShell+Reveal.swift — "open containing folder" navigation (#2518).
//
// Invoked from the info pane's clickable file-path row via the
// `\.revealFolderAction` environment value. Dispatches on `AssetRef` (cloud
// vs local vs none) using the pure `AssetRef.revealTarget` derivation, then
// returns the center column to the browse grid (pane shell: `mode = .browse`;
// iPhone: clear the Library `NavigationStack`).

import MapleCore
import SwiftUI

extension AppShell {
  /// Reveal `asset`'s containing folder in browse. Cloud assets re-open their
  /// library at the parent directory via `loadCloudLibrary`; local assets
  /// open the parent folder via the active bookmark (or a scope-less fallback,
  /// mirroring `navigateFolder`). PhotoKit assets have no folder — no-op.
  @MainActor
  func revealContainingFolder(of asset: AssetRef) {
    switch asset.revealTarget {
    case let .cloud(serverID, folderID, libraryPath):
      // Re-establishes librarySelection / cloudCurrentPath / persistence /
      // auth bootstrap / dir load / mode. Robust even from a foreign context.
      loadCloudLibrary(serverID: serverID, folderID: folderID, libraryPath: libraryPath)

    case let .local(parent):
      if let bookmark = currentRootBookmark {
        // Claims scope on the root and sets `mode = .browse` itself.
        openSubFolder(url: parent, rootBookmark: bookmark)
      } else {
        // No active bookmark — best-effort plain load, matching the
        // no-bookmark branch of `navigateFolder`.
        Task.detached { await ThumbnailLoader.shared.cancelAll() }
        browseVM.loadFolder(url: parent)
        librarySelection = .folder(path: parent.path)
        libraryTitle = parent.lastPathComponent
        pruneSessionsForNewAssetList()
      }

    case .none:
      return
    }

    // Drop the open image so the user lands on the folder's grid. The pane
    // shell selects the center column via `mode`; iPhone renders images via
    // the Library tab's NavigationStack, so clear that stack instead.
    mode = .browse
    #if os(iOS)
    if MapleShellKind.current == .phoneTab {
      libraryPath = []
    }
    #endif
  }
}
