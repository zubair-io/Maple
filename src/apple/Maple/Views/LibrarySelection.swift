// LibrarySelection.swift — which row in the LibrarySidebar is currently
// highlighted. Single active selection across the entire sidebar: either a
// folder, a Photos filter (All/Favorites/Picks/Rejects/Album), an SMB
// saved share, or a Maple Cloud library on a connected server.
//
// This is UI-only state — not persisted directly. The persistence layer
// (`SourceSelectionStore` + `SavedFolderStore` + Keychain) saves the
// underlying source-level identity so the app re-opens there.

import Foundation
import MapleCore

public enum LibrarySelection: Hashable {
    case none
    case folder(path: String)
    case photosFilter(PhotoKitFilter)
    case smbShare(SMBCredentialStore.SavedShare)
    /// Maple Cloud library — server URL + folder ObjectId from /api/folders.
    case cloudLibrary(serverID: URL, folderID: String)
    /// The unified cross-source Timeline (#2271/#2273) — every library on
    /// every connected Maple Cloud server, unioned with PhotoKit. Selected
    /// from the sidebar's TIMELINE row, which sits above the per-server
    /// sections rather than nesting under one of them.
    case allSources
    /// The native MapKit map view (#2830) — every located photo on the
    /// resolved cloud server (see `AppShell.resolveSearchServerURL()`;
    /// account-wide, same scoping as the phone Search tab, not tied to one
    /// library). Selected from the sidebar's MAP row, next to TIMELINE.
    case map
}
