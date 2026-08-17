// LibrarySourcesSettingsView+VM.swift — pure helpers for the app-level
// Settings → Sources page (#2925).
//
// Pattern (issue #192): every SwiftUI view with non-trivial derivation gets
// a sibling `+VM.swift` whose contents are unit-testable in isolation. This
// file MUST NOT `import SwiftUI` — a grep gate in CI enforces it.

import Foundation
import MapleCore

/// Namespace for pure `LibrarySourcesSettingsView` derivations.
enum LibrarySourcesVM {

    /// Secondary line under a saved local folder: its full path, middle-
    /// truncated by the view. Kept as a selector rather than inlined so the
    /// "what identifies a folder" decision has one home — `displayName` is
    /// only the last path component and two folders can share it.
    static func folderSubtitle(_ folder: SavedFolder) -> String {
        folder.path
    }

    /// Row title for an SMB share. `SavedShare` carries host / share /
    /// username separately; the sidebar shows `host / share`, so this page
    /// matches it rather than inventing a second naming scheme.
    static func shareTitle(_ share: SMBCredentialStore.SavedShare) -> String {
        "\(share.host) / \(share.share)"
    }

    /// Secondary line for an SMB share — the account it authenticates as.
    /// Two shares can differ only by user, which is exactly when the title
    /// alone stops being enough to tell them apart.
    static func shareSubtitle(_ share: SMBCredentialStore.SavedShare) -> String {
        share.username.isEmpty ? "Guest" : share.username
    }

    /// Footer under the whole page. Names the sidebar rule this page is the
    /// counterpart to, so a user who came here looking for a source that
    /// vanished from the tree learns why in the place they went looking.
    static let pageFooter =
        "The sidebar lists only sources you can browse right now. A folder on an "
        + "unplugged drive, an unmounted share, or a server where your account "
        + "doesn't have file access stays registered here and returns to the "
        + "sidebar once you can browse it."

    /// Empty-section copy. Each section states what the source kind is FOR
    /// rather than just "None" — this page is the first-run add surface, so
    /// an empty section is the common case, not an edge case.
    static let noFoldersCopy = "No local folders yet. Add one to browse RAW files already on this device."
    static let noSharesCopy = "No network shares yet. Add an SMB share to browse a NAS or file server."
    static let noServersCopy = "No Maple servers yet. Add one under Settings → Cloud."

    /// Row title for a registered cloud server: the operator-set display
    /// name when there is one, else the host, else the raw URL. Mirrors the
    /// same three-step fallback `LibrarySidebar` uses for its server
    /// sections so one server never reads as two different things.
    static func serverTitle(displayName: String?, url: URL) -> String {
        displayName ?? url.host ?? url.absoluteString
    }

    /// Whether adding this folder is a no-op because it's already saved.
    /// Re-picking a registered folder is a normal mistake (the picker
    /// doesn't show what's already added); it should read as "already
    /// there", not silently succeed into an unchanged list.
    static func isAlreadySaved(path: String, in folders: [SavedFolder]) -> Bool {
        folders.contains { $0.path == path }
    }
}
