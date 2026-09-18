// AppShell+SourceRestore.swift — cold-start source selection, split out of
// AppShell+FolderActions.swift (#3773; the file-budget headroom gate,
// #2311, is why it moved).
//
// Contents:
//   • restoreLastSource — cold-start dispatch over SourceSelectionStore
//   • autoPickInitialSource — cold-start fallback when no saved selection
//
// Both honour `FeatureFlags.isMapleCloudEnabled`: a cloud selection saved
// by a build that had Maple Cloud on never lands a release user inside a
// cloud grid the rest of the UI no longer shows, and registered servers
// are not a candidate source with the flag off.
//
// Same storage-sharing arrangement as the sibling `AppShell+*` extensions:
// these methods read/write `AppShell`'s internal `@State`.

import MapleCore
import SwiftUI

@MainActor
extension AppShell {
    // MARK: - Restore

    @MainActor
    func restoreLastSource() async {
        guard let selection = SourceSelectionStore.load() else {
            // Nothing saved → auto-pick the first sensible source so the
            // user lands on something instead of an empty grid that says
            // "Pick a folder in the sidebar." Priority: cloud > local > none.
            await autoPickInitialSource()
            return
        }
        switch selection {
        case .filesystem(let bookmark):
            // Route through the same non-recursive folder-walk that
            // openSavedFolder uses — we want sub-folders + immediate images,
            // not a flattened descendant list.
            var isStale = false
            let url: URL?
            #if os(macOS)
            url = try? URL(
                resolvingBookmarkData: bookmark,
                options: .withSecurityScope,
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            #else
            url = try? URL(
                resolvingBookmarkData: bookmark,
                options: [],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            #endif
            guard let folderURL = url else {
                // Bookmark went stale (folder moved/renamed/unmounted).
                // Drop the saved selection and fall back to the first
                // available source so the user lands on something instead
                // of an empty grid.
                SourceSelectionStore.clear()
                await autoPickInitialSource()
                return
            }
            // Hold scope for the whole session so detached render tasks work.
            claimScope(for: folderURL)
            currentRootBookmark = bookmark
            browseVM.currentScopeRoot = folderURL
            await ThumbnailDiskCache.shared.configure(folderURL: folderURL)
            await RenderedPreviewCache.shared.configure(folderURL: folderURL)
            librarySelection = .folder(path: folderURL.path)
            libraryTitle = folderURL.lastPathComponent
            browseVM.loadFolder(url: folderURL)
            pruneSessionsForNewAssetList()
        case .photoKit, .photoKitFilter:
            // Do NOT auto-load Photos on cold start. The user opted into
            // PhotoKit in a previous session; that's no excuse to ambush them
            // with a library of thousands of images every launch. They click
            // a Photos filter explicitly if they want it this session.
            //
            // Still pick a folder so they don't land on the empty "pick a
            // folder" state — `autoPickInitialSource` skips PhotoKit by
            // design so this is a clean fallback.
            await autoPickInitialSource()
        case .smb(let share):
            connectSavedSMB(share)
        case .cloudLibrary(let serverID, let folderID, let libraryPath):
            // #3773: a selection saved by a build that had Maple Cloud on
            // (TestFlight, an early build) must not land a release user
            // inside a cloud grid the rest of the UI no longer shows.
            guard FeatureFlags.isMapleCloudEnabled else {
                SourceSelectionStore.clear()
                await autoPickInitialSource()
                return
            }
            // Saved before the operator revoked file access (#2899)? The
            // browse grid would just 403 — fall back to the cross-source
            // Timeline instead. `sessionFor` restores from cache without a
            // network round-trip, so this check is cold-start-safe.
            let session = sessionFor(serverID)
            if !session.isSignedIn { await session.bootstrapAndRestore() }
            guard session.hasFileAccess else {
                SourceSelectionStore.clear()
                openAllSourcesTimeline()
                return
            }
            loadCloudLibrary(serverID: serverID, folderID: folderID, libraryPath: libraryPath)
        }
    }

    /// Cold-start fallback when there's no saved selection. Picks the
    /// first sensible source so the user lands on something instead of
    /// staring at "Pick a folder in the sidebar." Priority:
    /// 1. First registered cloud server's first library
    /// 2. Most-recent local folder from SavedFolderStore
    /// 3. The Photos library
    ///
    /// PhotoKit sits last because a user who already has a cloud library or
    /// a saved folder has told us what they browse. It used to be excluded
    /// outright as "permission-gated and ambushy", but that hasn't been
    /// true since #2454 made selection and authorization separate steps:
    /// `loadPhotos` only reads `authorizationStatus()` (which never
    /// prompts) and hands an unauthorized library to the grid's permission
    /// panel. The system dialog still fires from exactly one place — that
    /// panel's Connect button.
    ///
    /// Landing here IS the point on a fresh install (#2924): with no cloud
    /// server and no saved folder, the alternative was an empty grid whose
    /// copy pointed at a sidebar the phone keeps behind a drawer.
    @MainActor
    func autoPickInitialSource() async {
        // Tracks whether any signed-in server denied file access (#2899):
        // such a member has no browse surface anywhere, so once every other
        // fallback is exhausted the cross-source Timeline is their home,
        // matching the web app's restricted-member landing.
        var sawRestrictedServer = false
        // #3773: with Maple Cloud off, registered servers are not a source.
        let candidateServers = FeatureFlags.isMapleCloudEnabled ? CloudServerRegistry.shared.servers : []
        for serverURL in candidateServers {
            let session = sessionFor(serverURL)
            if !session.isSignedIn { await session.bootstrapAndRestore() }
            guard session.isSignedIn else { continue }
            // Restricted on THIS server — keep checking the others; the
            // same account can be full-access on a different server.
            guard session.hasFileAccess else {
                sawRestrictedServer = true
                continue
            }
            let libs = await loadCloudFoldersFor(serverURL)
            if let first = libs.first {
                loadCloudLibrary(serverID: serverURL,
                                 folderID: first.id,
                                 libraryPath: first.path)
                return
            }
        }
        if let recent = SavedFolderStore.mostRecent() {
            openSavedFolder(recent)
            return
        }
        // Restricted members keep landing on the Timeline (#2899) — that
        // decision is about a server account with no browse surface, and the
        // Photos fallback below doesn't change it.
        if sawRestrictedServer {
            openAllSourcesTimeline()
            return
        }
        loadPhotos(filter: .all)
    }
}
