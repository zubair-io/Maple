// TrashBrowserContext.swift — which source's in-app Trash the browser is
// showing (#2653). Only `.maple/trash`-backed sources get one: iOS/iPadOS
// Filesystem and SMB (no OS trash), and Cloud (the server's trash). macOS
// Filesystem never constructs one — see `AppShell+Trash.swift`'s file
// header for why Finder is the UI there.

import Foundation
import MapleCore

enum TrashBrowserContext: Identifiable {
    case local(libraryRoot: URL, rootBookmark: Data, displayName: String)
    case smb(SMBCredentialStore.SavedShare)
    case cloud(server: URL, libraryFolderID: String, displayName: String)

    var id: String {
        switch self {
        case .local(let root, _, _): return "local:\(root.path)"
        case .smb(let share): return "smb:\(share.host)/\(share.share)"
        case .cloud(let server, let libraryFolderID, _): return "cloud:\(server.absoluteString)/\(libraryFolderID)"
        }
    }

    var title: String {
        switch self {
        case .local(_, _, let displayName): return displayName
        case .smb(let share): return "\(share.host) / \(share.share)"
        case .cloud(_, _, let displayName): return displayName
        }
    }
}
