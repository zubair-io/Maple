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
}
