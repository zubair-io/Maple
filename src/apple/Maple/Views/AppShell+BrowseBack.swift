// AppShell+BrowseBack.swift — the iPad Browse header's back button: opens the
// parent of the folder on screen, stopping at the source's root.

#if os(iOS)

  import MapleCore
  import SwiftUI

  @MainActor
  extension AppShell {
    var browseParentFolderAction: (() -> Void)? {
      browseBackTarget.map { parent in { navigateFolder(URL(fileURLWithPath: parent)) } }
    }

    /// Resolved when the location changes, not per render: a cloud library's
    /// root comes from its on-disk folder cache. The parent keeps the current
    /// folder's path spelling, which the sidebar and caches key on, rather
    /// than the bookmark-resolved root's `/private/var` form.
    func refreshBrowseBackTarget() {
      guard case .located(let location) = resolvePhoneFolderLocation(),
        !location.levelPaths.isEmpty
      else {
        browseBackTarget = nil
        return
      }
      browseBackTarget =
        URL(fileURLWithPath: location.currentPath)
        .deletingLastPathComponent().path
    }
  }

#endif
