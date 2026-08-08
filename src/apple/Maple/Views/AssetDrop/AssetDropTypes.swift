// AssetDropTypes.swift — shared vocabulary for the drag-assets-onto-the-
// source-tree flow (#2646). Small, UI-facing types only; the actual
// routing/file-op logic lives in `AppShell+AssetDrop.swift`.

import Foundation
import MapleCore

// MARK: - AssetDropDestination

/// Where a drag (or its keyboard/menu equivalent, "Move/Copy Selected
/// Here") landed. One case per source kind the source tree shows today.
/// PhotoKit deliberately has no case — the design doc: "PhotoKit is not a
/// drag source or target" — so a PhotoKit row never constructs one of
/// these in the first place.
enum AssetDropDestination: Equatable {
    /// `rootBookmark` is the nearest saved ancestor's security-scope
    /// bookmark — the same value `FolderTreeRow` already threads to every
    /// depth (see `AppShell+FolderContextMenu.swift`'s `withLocalFolderScope`).
    case local(folderURL: URL, rootBookmark: Data)
    /// SMB has no subfolder tree in the sidebar yet (#2697), so the only
    /// valid SMB drop target is the connected share's root.
    case smb(share: SMBCredentialStore.SavedShare)
    case cloud(server: URL, libraryFolderID: String, libraryRootPath: String, absPath: String)
}

// MARK: - AssetDropCollisionPrompt

/// Carries a pending collision decision from `AppShell+AssetDrop.swift`'s
/// routing loop to the `AssetDropCollisionSheet` and back. `resolver` is
/// the SAME `AssetDropCollisionResolver` instance the routing loop is
/// awaiting — both a button tap (via this prompt) and the sheet's implicit
/// dismissal (via `AppShell`'s separate `assetDropCollisionResolver`
/// state, set at the same time as this prompt) can resolve it; the
/// resolver itself guarantees only the first call actually resumes
/// anything. See `AssetDropCollisionResolver`'s doc comment (MapleCore).
struct AssetDropCollisionPrompt: Identifiable {
    let id = UUID()
    let displayName: String
    let resolver: AssetDropCollisionResolver
}

// MARK: - AssetDropItemResult

/// One item's outcome, for the end-of-batch report. The design doc:
/// "report per-item outcomes including partial failure — do not collapse
/// it to a single alert." A summary sheet is presented only when at least
/// one item is `.skipped`/`.failed`; an all-`.moved`/`.copied` batch
/// completes silently, matching Finder's own drag-and-drop.
struct AssetDropItemResult: Identifiable {
    let id: AssetRef.ID
    let displayName: String
    let outcome: Outcome

    enum Outcome: Equatable {
        case moved
        case copied
        case skipped(reason: String)
        case failed(String)
    }
}
