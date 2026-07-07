// AppShell+FolderActions.swift — local-folder source loading + security-scope
// lifecycle, lifted out of AppShell.swift as part of the multi-PR split
// tracked in #123 (slice 3).
//
// Contents:
//   • loadFolder / navigateFolder / openEditor / openSubFolder /
//     openSavedFolder — the filesystem-picker + sub-folder drill-down flows
//   • restoreLastSource — cold-start dispatch over SourceSelectionStore
//   • autoPickInitialSource — cold-start fallback when no saved selection
//   • ensureSession — lazy per-asset EditSession creation (called from
//     BrowseGrid cell .onAppear)
//   • claimScope / releaseScope — macOS sandbox security-scope lifecycle
//
// These methods read/write `@State` properties on `AppShell` (e.g.
// `librarySelection`, `mode`, `browseVM`, `sessions`, …). Extensions in the
// same module share storage with the parent struct, so the move was
// possible without restructuring state ownership — but the `@State`
// declarations on `AppShell` had to drop `private` to default-internal so
// this file (and the sibling Cloud/PhotoKit extensions) can see them.
//
// The extension is annotated `@MainActor` so the inner methods can drop
// their per-method `@MainActor` annotations and still mutate state. We
// kept the per-method annotations on the spot for now to minimise diff
// noise; they're redundant-but-harmless inside a MainActor extension.

import SwiftUI
import MapleCore

@MainActor
extension AppShell {
    // MARK: - Folder flows

    @MainActor
    func loadFolder(url: URL) {
        // Cancel any in-flight thumbnail decodes from the previous folder so
        // they don't keep burning CPU against files the user no longer sees.
        Task.detached { await ThumbnailLoader.shared.cancelAll() }
        // Configure folder-scoped caches so thumbnails land in the folder's
        // .maple/ directory (matches Maple Hosted).
        Task.detached {
            await ThumbnailDiskCache.shared.configure(folderURL: url)
            await RenderedPreviewCache.shared.configure(folderURL: url)
            await DecodedBufferCache.shared.configure(folderURL: url)
        }

        // Claim scope on the picker URL FIRST, before any filesystem read.
        // The URL from `.fileImporter` is scope-backed but sandboxed reads
        // require `startAccessingSecurityScopedResource()` to be active at
        // the moment the read happens — otherwise the sync listing below
        // fails with `fileReadUnknown`, `loadError` pops the red banner,
        // and yet the later `FilesystemSource.open` + `SavedFolderStore`
        // upsert still succeed (because those paths re-claim scope on
        // their own), so the folder ends up in the sidebar and usable —
        // but the user just saw a spurious "can't open folder" error.
        claimScope(for: url)

        // `url` here came from `.fileImporter` which returns a scope-backed
        // URL — propagate it to the VM so each synthesised AssetRef carries
        // the scope reference through to the pipeline / loader.
        browseVM.currentScopeRoot = url
        browseVM.loadFolder(url: url)
        librarySelection = .folder(path: url.path)
        libraryTitle = url.lastPathComponent
        mode = .browse

        for asset in browseVM.assets where sessions[asset.id] == nil {
            // FileProvider observer (see EditSession+Hydration) drives this
            // when the URL is a Files-app / iCloud sidebar asset; local files
            // never call begin() so the overlay stays hidden.
            let session = EditSession(asset: asset,
                                      downloadProgress: DownloadProgress())
            sessions[asset.id] = session
            Task { await session.loadSidecar() }
        }
        Task { @MainActor in
            let fs = FilesystemSource()
            do {
                try await fs.open(folderURL: url)
                if let data = await fs.persistableBookmark {
                    currentRootBookmark = data
                    SourceSelectionStore.save(.filesystem(bookmark: data))
                    SavedFolderStore.upsert(SavedFolder(
                        path: url.path,
                        displayName: url.lastPathComponent,
                        bookmark: data,
                        lastOpened: Date()
                    ))
                }
            } catch {
                // Non-fatal — next launch simply lands on the empty state.
            }
        }
    }

    /// Single-click on a sub-folder cell in the explorer grid. Navigates into
    /// the sub-folder using the currently-active root bookmark for security
    /// scope.
    @MainActor
    func navigateFolder(_ url: URL) {
        // Cloud-library context: drill into the subfolder via /api/fs/dir
        // instead of the filesystem-bookmark path. URL.path carries the
        // server-side absolute path. We don't update LibrarySelection
        // because the drilled-in path is browser state, not a sidebar
        // selection — the user is still on the same library row.
        if case .cloudLibrary(let serverID, let folderID) = librarySelection,
           let source = browseVM.currentSource as? CloudSource {
            cloudCurrentPath = url.path
            // Persist the drilled-in path so cold start restores at the
            // current depth (and the sidebar auto-expands the ancestor
            // chain to match).
            SourceSelectionStore.save(.cloudLibrary(serverID: serverID,
                                                    folderID: folderID,
                                                    libraryPath: url.path))
            Task { @MainActor in
                await browseVM.loadCloudDir(source, absPath: url.path)
                libraryTitle = url.lastPathComponent
            }
            return
        }

        guard let bookmark = currentRootBookmark else {
            // Fall back to a plain loadFolder — works for folders inside the
            // user's security-scope, fails silently for sandboxed reads.
            // Keep whatever scope root is already active.
            Task.detached { await ThumbnailLoader.shared.cancelAll() }
            browseVM.loadFolder(url: url)
            librarySelection = .folder(path: url.path)
            libraryTitle = url.lastPathComponent
            return
        }
        openSubFolder(url: url, rootBookmark: bookmark)
    }

    /// Open an image from a NON-tap path (deep link, document open). Grid taps
    /// don't route through here — the grids call the shell-provided open
    /// callback directly (iPhone pushes `.preview` onto its NavigationStack;
    /// the pane shell flips `mode`). This method mirrors that split so a
    /// deep-link / document-open lands the photo the same way a tap would.
    ///
    /// Fast Preview §1: opening now targets the fast static Preview surface
    /// (`.preview`), not the editor directly.
    @MainActor
    func openEditor(for asset: AssetRef) {
        // Make sure the session exists (usually pre-created by primeSessions…).
        if sessions[asset.id] == nil {
            // FileProvider observer drives this on Files-app picks; local
            // files never call begin() and stay overlay-free.
            let session = EditSession(asset: asset,
                                      downloadProgress: DownloadProgress())
            sessions[asset.id] = session
            Task { await session.loadSidecar() }
        }
        browseVM.selectedID = asset.id
        #if os(iOS)
        // iPhone: the shell renders images via the Library tab's
        // NavigationStack, NOT the pane-shell `mode`. Push `.preview` onto that
        // stack (same target as a grid tap) so deep-link / document-open
        // actually surface the photo — `mode = .preview` alone would leave the
        // grid on screen because `AppShellIPhoneShell` renders the center image
        // surface for `mode == .fullImage` only. Reset the stack first so an
        // in-flight editor push is replaced, not stacked under, the new open.
        if MapleShellKind.current == .phoneTab {
            libraryPath = [.preview(asset)]
            return
        }
        #endif
        // Mac/iPad pane shell: flip the center column to the Preview surface.
        mode = imageOpenMode
    }

    /// Open a sub-folder inside a previously-saved top-level folder. Uses the
    /// root's bookmark to claim security scope (child URLs inherit it), loads
    /// the sub-folder's immediate children into the grid, and marks the
    /// sub-folder as the current library selection. Does NOT persist to
    /// `SavedFolderStore` — only top-level folders live in the recent list.
    @MainActor
    func openSubFolder(url: URL, rootBookmark: Data) {
        librarySelection = .folder(path: url.path)
        libraryTitle = url.lastPathComponent
        currentRootBookmark = rootBookmark
        mode = .browse
        Task.detached { await ThumbnailLoader.shared.cancelAll() }
        Task.detached {
            await ThumbnailDiskCache.shared.configure(folderURL: url)
            await RenderedPreviewCache.shared.configure(folderURL: url)
            await DecodedBufferCache.shared.configure(folderURL: url)
        }
        Task { @MainActor in
            // Claim security scope via the root's bookmark. Child URLs live
            // inside the same scope on macOS, so a sandboxed read works.
            var isStale = false
            let rootURL: URL?
            #if os(macOS)
            rootURL = try? URL(
                resolvingBookmarkData: rootBookmark,
                options: .withSecurityScope,
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            #else
            rootURL = try? URL(
                resolvingBookmarkData: rootBookmark,
                options: [],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            #endif
            // Hold scope open for the whole browse session — the URL must be
            // bookmark-resolved (not built from `URL(fileURLWithPath:)`), so
            // we claim on `rootURL`. Sub-folder URLs inherit the scope.
            if let rootURL { claimScope(for: rootURL) }
            // Propagate the scope-backed root to the VM so synthesised
            // AssetRefs carry it (enables sandboxed Rust FFI reads).
            browseVM.currentScopeRoot = rootURL
            // Non-recursive walk of the sub-folder — the grid shows only
            // RAWs directly inside it, matching Finder-style drill-down.
            browseVM.loadFolder(url: url)
        }
    }

    /// Re-open a folder the user previously picked, using its stored bookmark
    /// so we don't retrigger the system picker.
    @MainActor
    func openSavedFolder(_ folder: SavedFolder) {
        librarySelection = .folder(path: folder.path)
        libraryTitle = folder.displayName
        currentRootBookmark = folder.bookmark
        mode = .browse
        Task.detached { await ThumbnailLoader.shared.cancelAll() }
        // Resolve the bookmark, claim security scope, then run the native
        // filesystem walker (which populates `subfolders` + `assets`). We
        // deliberately avoid `loadSource(fs)` here — that path is for sources
        // without a URL model (PhotoKit / SelfHosted) and doesn't surface
        // sub-folders.
        Task { @MainActor in
            var isStale = false
            let url: URL?
            #if os(macOS)
            url = try? URL(
                resolvingBookmarkData: folder.bookmark,
                options: .withSecurityScope,
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            #else
            url = try? URL(
                resolvingBookmarkData: folder.bookmark,
                options: [],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            #endif
            guard let folderURL = url else {
                browseVM.loadError = CocoaError(.fileReadNoPermission)
                return
            }
            // Hold scope open for the whole browse session — detached render
            // tasks (thumbnails, editor) need process-wide scope when they
            // eventually call into Rust. The previous `defer { stop }` released
            // before any of them ran, which is why Rust saw EPERM.
            claimScope(for: folderURL)
            // Scope-backed root for the VM so AssetRefs carry the token.
            browseVM.currentScopeRoot = folderURL
            await ThumbnailDiskCache.shared.configure(folderURL: folderURL)
            await RenderedPreviewCache.shared.configure(folderURL: folderURL)
            await DecodedBufferCache.shared.configure(folderURL: folderURL)
            browseVM.loadFolder(url: folderURL)
            SourceSelectionStore.save(.filesystem(bookmark: folder.bookmark))
            SavedFolderStore.upsert(SavedFolder(
                path: folder.path,
                displayName: folder.displayName,
                bookmark: folder.bookmark,
                lastOpened: Date()
            ))
        }
    }

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
            await DecodedBufferCache.shared.configure(folderURL: folderURL)
            librarySelection = .folder(path: folderURL.path)
            libraryTitle = folderURL.lastPathComponent
            browseVM.loadFolder(url: folderURL)
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
            loadCloudLibrary(serverID: serverID, folderID: folderID, libraryPath: libraryPath)
        }
    }

    /// Cold-start fallback when there's no saved selection. Picks the
    /// first sensible source so the user lands on something instead of
    /// staring at "Pick a folder in the sidebar." Priority:
    /// 1. First registered cloud server's first library
    /// 2. Most-recent local folder from SavedFolderStore
    /// PhotoKit is intentionally NOT auto-picked — it's permission-
    /// gated and ambushy.
    @MainActor
    func autoPickInitialSource() async {
        for serverURL in CloudServerRegistry.shared.servers {
            let session = sessionFor(serverURL)
            if !session.isSignedIn { await session.bootstrapAndRestore() }
            guard session.isSignedIn else { continue }
            let libs = await loadCloudFoldersFor(serverURL)
            if let first = libs.first {
                loadCloudLibrary(serverID: serverURL,
                                 folderID: first.id,
                                 libraryPath: first.path)
                return
            }
        }
        if let first = SavedFolderStore.load().first {
            openSavedFolder(first)
            return
        }
    }

    // MARK: - Sessions

    @MainActor
    /// Lazy per-asset session creation. Called from `BrowseGrid`'s
    /// thumbnail-cell `.onAppear` so a session is built only when the
    /// cell scrolls into view, NOT eagerly across the entire folder.
    /// User reported on iPad: opening a 70-asset folder fired 70+
    /// `loadSidecar()` calls — every one a `CIRAWFilter` instantiation
    /// and an XMP store read for an asset the user might never tap.
    /// SwiftUI's `LazyVGrid` already defers cell instantiation; this
    /// closes the matching gap on the session model.
    func ensureSession(for asset: AssetRef) {
        guard sessions[asset.id] == nil else { return }
        let remoteStore: (any SidecarStoreProtocol)? = {
            // Cloud-backed asset: route XMP through CloudSidecarStore so
            // edits round-trip via PUT /api/assets/<id>/xmp. Local files
            // (folder/SMB) keep using XMPSidecarStore via EditSession's
            // primaryURL branch. Cloud refs carry the upstream asset id
            // in stableID (set by BrowseViewModel.loadSource).
            guard case .cloudLibrary(let serverID, _) = librarySelection,
                  let assetID = asset.stableID
            else { return nil }
            return CloudSidecarStore(
                server: serverID,
                assetID: assetID,
                httpClient: makeAuthenticatedHTTPClient(server: serverID))
        }()
        // FileProvider observer is no-op for cloud-library assets (sourceless
        // — no primaryURL), so passing DownloadProgress here is safe; the
        // overlay only fires when the observer's begin() runs.
        let session = EditSession(asset: asset,
                                  remoteSidecarStore: remoteStore,
                                  downloadProgress: DownloadProgress())
        sessions[asset.id] = session
        Task { await session.loadSidecar() }
    }

    // MARK: - Security scope lifecycle

    /// Claim security scope on the given URL for the whole current browse
    /// session. Releases any prior claim. `url` MUST be a bookmark-resolved
    /// URL (from `URL(resolvingBookmarkData:)`) — plain `URL(fileURLWithPath:)`
    /// is NOT scope-backed on macOS and the start call silently no-ops.
    @MainActor
    func claimScope(for url: URL) {
        // Drop the prior claim first — reclaiming on the same URL is fine,
        // but we must release the old one before switching folders.
        releaseScope()
        let ok = url.startAccessingSecurityScopedResource()
        if ok { activeScopeURL = url }
    }

    @MainActor
    func releaseScope() {
        if let prev = activeScopeURL {
            prev.stopAccessingSecurityScopedResource()
            activeScopeURL = nil
        }
    }
}
