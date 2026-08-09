// AppShellSidebar.swift — sibling wrapper around `LibrarySidebar` that
// fans out AppShell's full callback set. Extracted from AppShell.swift
// as part of the multi-PR split tracked in #123 (slice 4).
//
// Why: AppShell previously declared `librarySidebarView` (Mac/iPad
// shell) and `iPhoneSidebar` (drawer) as separate ~45-LOC computed
// properties that wired the exact same 13 callbacks into the exact
// same `LibrarySidebar(...)` call. Lifting the shared call into one
// sibling collapses ~90 LOC of duplicate plumbing and gives the two
// layout structs (`AppShellMacLayout` / `AppShellIPhoneDrawer`) a
// single, reusable sidebar surface.
//
// Surface: a `@Binding` for the row selection plus one closure per
// LibrarySidebar callback. Closures (not bindings) on purpose — the
// callbacks invoke AppShell methods that take URLs / IDs and may
// dispatch async work, so a binding can't model them.

import SwiftUI
import MapleCore

struct AppShellSidebar: View {
    @Binding var selection: LibrarySelection
    let cloudCurrentPath: String?
    let onAddFolder: () -> Void
    let onPickFolder: (SavedFolder) -> Void
    let onRemoveFolder: (SavedFolder) -> Void
    let onPickAncestor: (URL, Data) -> Void
    /// Source-tree context menu (#2645) — forwarded to `LibrarySidebar`;
    /// see its declaration for the full contract.
    let onCreateFolder: (URL, Data, String) -> Void
    let onRenameFolder: (URL, Data, String) -> Void
    let onTrashFolder: (URL, Data) -> Void
    /// Drag-onto-source-tree (#2646) — forwarded to `LibrarySidebar`; see
    /// its declarations for the full `ids == nil` ⇒ "use current
    /// selection" contract.
    var onDropAssets: (URL, Data, Set<AssetRef.ID>?, Bool) -> Void = { _, _, _, _ in }
    var onDropAssetsSMB: (SMBCredentialStore.SavedShare, Set<AssetRef.ID>?, Bool) -> Void = { _, _, _ in }
    var onDropAssetsCloud: (URL, String, String, String, Set<AssetRef.ID>?, Bool) -> Void = { _, _, _, _, _, _ in }
    var selectedAssetCount: Int = 0
    var folderRefreshGeneration: Int = 0
    let onPickPhotosFilter: (PhotoKitFilter) -> Void
    let onRequestPhotosAccess: () -> Void
    /// Forwarded to `LibrarySidebar` — see its declaration (#2454).
    var photosAuthGeneration: Int = 0
    let onAddSMB: () -> Void
    let onPickSMB: (SMBCredentialStore.SavedShare) -> Void
    let onCreateSMBFolder: (SMBCredentialStore.SavedShare, String) -> Void
    let onAddCloudServer: () -> Void
    let onPickCloudLibrary: (URL, String, String) -> Void
    let onListCloudDir: (URL, String) async -> FsDirListing?
    let onSignOutCloudServer: (URL) -> Void
    let onSignInCloudServer: (URL) -> Void
    let sessionFor: @MainActor (URL) -> AuthSession
    let onRemoveCloudServer: (URL) -> Void
    let onLoadCloudFolders: (URL) async -> [CloudFolder]
    let onCreateCloudFolder: (URL, String, String, String, String) -> Void
    let onRenameCloudFolder: (URL, String, String, String, String) -> Void
    var onTrashCloudFolder: (URL, String, String, String) -> Void = { _, _, _, _ in }
    var onShowLocalTrash: ((URL, Data, String) -> Void)? = nil
    var onShowSMBTrash: ((SMBCredentialStore.SavedShare) -> Void)? = nil
    var onShowCloudTrash: ((URL, String, String) -> Void)? = nil
    let onSelectTimeline: () -> Void
    /// OS file/folder drop-to-mount (#2649) — forwarded to `LibrarySidebar`;
    /// see its declaration for why every row needs this in addition to a
    /// window-level handler.
    var onDropURLs: ([URL]) -> Bool = { _ in false }

    var body: some View {
        LibrarySidebar(
            selection: $selection,
            onAddFolder: onAddFolder,
            onPickFolder: onPickFolder,
            onRemoveFolder: onRemoveFolder,
            onPickAncestor: onPickAncestor,
            onCreateFolder: onCreateFolder,
            onRenameFolder: onRenameFolder,
            onTrashFolder: onTrashFolder,
            onDropAssets: onDropAssets,
            selectedAssetCount: selectedAssetCount,
            folderRefreshGeneration: folderRefreshGeneration,
            onPickPhotosFilter: onPickPhotosFilter,
            onRequestPhotosAccess: onRequestPhotosAccess,
            photosAuthGeneration: photosAuthGeneration,
            onAddSMB: onAddSMB,
            onPickSMB: onPickSMB,
            onCreateSMBFolder: onCreateSMBFolder,
            onDropAssetsSMB: onDropAssetsSMB,
            onAddCloudServer: onAddCloudServer,
            onPickCloudLibrary: onPickCloudLibrary,
            onListCloudDir: onListCloudDir,
            cloudCurrentPath: cloudCurrentPath,
            onSignOutCloudServer: onSignOutCloudServer,
            onSignInCloudServer: onSignInCloudServer,
            sessionFor: sessionFor,
            onRemoveCloudServer: onRemoveCloudServer,
            onLoadCloudFolders: onLoadCloudFolders,
            onCreateCloudFolder: onCreateCloudFolder,
            onRenameCloudFolder: onRenameCloudFolder,
            onTrashCloudFolder: onTrashCloudFolder,
            onDropAssetsCloud: onDropAssetsCloud,
            onShowLocalTrash: onShowLocalTrash,
            onShowSMBTrash: onShowSMBTrash,
            onShowCloudTrash: onShowCloudTrash,
            onSelectTimeline: onSelectTimeline,
            onDropURLs: onDropURLs
        )
    }
}
