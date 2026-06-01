// AppShell+CloudActions.swift — Maple Cloud / Self-Hosted source loading,
// lifted out of AppShell.swift as part of the multi-PR split tracked in
// #123 (slice 3).
//
// Contents:
//   • makeAuthenticatedHTTPClient — single factory for the 401-refresh
//     coalescing client; shared across folders/timeline/thumbs for a
//     given server
//   • loadCloudFoldersFor — sidebar's per-server /api/folders fetch
//     (with offline cache fallback)
//   • listCloudDirFor — sidebar tree-row directory listing
//   • loadCloudLibrary — folder-mode + timeline-mode library open
//   • openCloudAsset — open a single cloud asset in the editor with a
//     server-backed sidecar store
//
// The `cloudHTTPLogger` is scoped to this file — it's the only place that
// logs an HTTP-fallback path.

import SwiftUI
import OSLog
import MapleCore

private let cloudHTTPLogger = Logger(subsystem: "app.justmaple.aperture", category: "Cloud.HTTP")

@MainActor
extension AppShell {
    @MainActor
    func makeAuthenticatedHTTPClient(server: URL) -> AuthenticatedHTTPClient {
        AuthenticatedHTTPClient(
            server: server,
            urlSession: .shared,
            tokensProvider: { try? TokenStore.load(server: server) },
            onTokensRefreshed: { try? TokenStore.save($0, server: server) },
            onSignOut: { TokenStore.clear(server: server) }
        )
    }

    @MainActor
    func loadCloudFoldersFor(_ url: URL) async -> [CloudFolder] {
        // The sidebar's CloudServerSection .task fires at app launch in
        // parallel with restoreLastSource → bootstrapAndRestore. Without
        // the same await dance autoPickInitialSource / loadCloudLibrary
        // do, the /api/folders request races out before tokens are
        // restored — server replies 401 "missing bearer", the
        // AuthenticatedHTTPClient's refresh path also finds no tokens
        // (race), and we silently return []. Awaiting bootstrap here
        // ensures the keychain restore is complete before tokensProvider
        // is consulted.
        let session = sessionFor(url)
        if !session.isSignedIn { await session.bootstrapAndRestore() }
        guard session.isSignedIn else { return [] }

        let httpClient = makeAuthenticatedHTTPClient(server: url)
        let client = CloudFoldersClient(server: url, httpClient: httpClient)
        do {
            let folders = try await client.listFolders()
            CloudFoldersCache.save(folders, server: url)
            return folders
        }
        catch {
            // Offline / server hiccup — fall back to the last-known
            // folder list so the sidebar still has something to render.
            // Returning [] here used to give the user an empty sidebar
            // every time the network blipped.
            //
            // Log the swallowed error so triage can distinguish "live
            // request failed; served cached data" from "live request
            // succeeded but returned no folders" — invisible before.
            let cached = CloudFoldersCache.load(server: url)
            cloudHTTPLogger.info(
              "listFolders failed for \(url.absoluteString, privacy: .public): \(error.localizedDescription, privacy: .public) — fallback: \(cached != nil ? "cache (\(cached!.count) folders)" : "empty", privacy: .public)"
            )
            return cached ?? []
        }
    }

    @MainActor
    func listCloudDirFor(server: URL, absPath: String) async -> FsDirListing? {
        // Same cold-start race as loadCloudFoldersFor — wait for
        // bootstrap before calling /api/fs/dir so the request actually
        // carries a bearer token. Sidebar tree-row expansion can fire
        // this before AuthSession.user is hydrated from Keychain.
        let session = sessionFor(server)
        if !session.isSignedIn { await session.bootstrapAndRestore() }
        guard session.isSignedIn else { return nil }

        let httpClient = makeAuthenticatedHTTPClient(server: server)
        let client = CloudFoldersClient(server: server, httpClient: httpClient)
        do { return try await client.listDir(absPath: absPath) }
        catch { return nil }
    }

    /// Human-readable header title for an open cloud library. Returns the
    /// FIRST available of (a fallback chain, not a concatenation):
    ///   1. the server's registry display name (what the sidebar shows, e.g. "MAPLE"),
    ///   2. the registered library/folder label,
    ///   3. the last path segment of whatever the user has drilled into.
    /// The URL host is the last resort — used only when none of the above
    /// exist, so the header no longer shows the bare `serverID.host` (#782).
    @MainActor
    func cloudLibraryTitle(serverID: URL, folderID: String, libraryPath: String) -> String {
        if let name = CloudServerRegistry.shared.displayName(for: serverID) {
            return name
        }
        if let folder = CloudFoldersCache.load(server: serverID)?
            .first(where: { $0.id == folderID }) {
            return folder.displayName
        }
        let leaf = (libraryPath as NSString).lastPathComponent
        if !leaf.isEmpty { return leaf }
        return serverID.host ?? serverID.absoluteString
    }

    @MainActor
    func loadCloudLibrary(serverID: URL, folderID: String, libraryPath: String) {
        librarySelection = .cloudLibrary(serverID: serverID, folderID: folderID)
        cloudCurrentPath = libraryPath
        SourceSelectionStore.save(.cloudLibrary(serverID: serverID, folderID: folderID, libraryPath: libraryPath))
        currentRootBookmark = nil

        Task { @MainActor in
            let session = sessionFor(serverID)
            // On cold start, sessionFor() returns a freshly-constructed
            // session whose Keychain restore is still in flight. Awaiting
            // bootstrapAndRestore() before checking isSignedIn lets that
            // restore finish — otherwise we'd always fall through to the
            // sign-in sheet on first launch even though tokens exist.
            //
            // For sessions that are already signed in (warm cache, sidebar
            // click during the session), isSignedIn short-circuits and the
            // await is skipped.
            //
            // For sessions where signOut() was called or refresh failed,
            // bootstrapAndRestore() returns without setting user, isSignedIn
            // stays false, and we route to the prefilled sign-in sheet —
            // same as the previous synchronous behavior.
            if !session.isSignedIn {
                await session.bootstrapAndRestore()
            }
            guard session.isSignedIn else {
                addCloudSheetTarget = .prefilled(serverID.host ?? serverID.absoluteString)
                return
            }

            let viewMode = CloudServerRegistry.shared.viewMode(for: serverID)
            switch viewMode {
            case .folder:
                cloudTimelineVM = nil
                let httpClient = makeAuthenticatedHTTPClient(server: serverID)
                let source = CloudSource(server: serverID,
                                         folderID: folderID,
                                         libraryPath: libraryPath,
                                         httpClient: httpClient)
                // Use the dir-listing loader so the grid shows BOTH
                // subfolders and images at this level.
                await browseVM.loadCloudDir(source, absPath: libraryPath)

                // Path-not-on-server fallback. If the persisted path
                // was renamed or deleted server-side, /api/fs/dir 4xx's
                // and BrowseViewModel.loadError gets set. Look up the
                // library's registered root via /api/folders and retry
                // there, then update the persisted selection so cold
                // start no longer points at the missing path.
                if browseVM.loadError != nil {
                    let foldersClient = CloudFoldersClient(server: serverID,
                                                           httpClient: httpClient)
                    if let libs = try? await foldersClient.listFolders(),
                       let registered = libs.first(where: { $0.id == folderID }),
                       registered.path != libraryPath {
                        // The original 4xx is already logged by CloudSource's
                        // decode-error path; no need for an extra line here.
                        cloudCurrentPath = registered.path
                        SourceSelectionStore.save(.cloudLibrary(serverID: serverID,
                                                                folderID: folderID,
                                                                libraryPath: registered.path))
                        await browseVM.loadCloudDir(source, absPath: registered.path)
                    }
                }

                libraryTitle = cloudLibraryTitle(serverID: serverID,
                                                 folderID: folderID,
                                                 libraryPath: cloudCurrentPath ?? libraryPath)
                mode = .browse
            case .timeline:
                browseVM.clear()
                // Single AuthenticatedHTTPClient shared by the search +
                // thumb clients for the lifetime of this Timeline VM.
                // Defeats the 401-refresh-storm bug if many cells hit
                // expired tokens at once — only one /api/auth/refresh
                // call goes out, all callers wait on the same continuation.
                let httpClient = makeAuthenticatedHTTPClient(server: serverID)
                let searchClient = CloudSearchClient(server: serverID, httpClient: httpClient)
                // Scope the Timeline to whatever the user picked in the
                // sidebar — the library root, or a subfolder when they pick
                // deeper. The server matches pathPrefix against
                // `fileinfo.path` (relative to the library root), so we send
                // a library-RELATIVE prefix; libraryID handles the
                // library-wide scope. Both /api/search/buckets and
                // /api/search get the same prefix so bucket counts and asset
                // listings describe the same scope. (Sending the absolute
                // libraryPath here is what left the Timeline empty.)
                // Construct a PhotoKitMergeAdapter when this cloud library is
                // the configured backup destination AND the user has granted
                // PhotoKit access. This enables the merged Photos+Cloud view
                // so the user sees local-only, synced, and cloud-only cells
                // with sync-status badges.
                let photoKitMerge: PhotoKitMergeAdapter? = {
                    guard let settings = BackupSettings.load(),
                          settings.isConfigured,
                          settings.serverURL == serverID.absoluteString,
                          settings.libraryId == folderID else { return nil }
                    let status = PhotoKitLibrary.authorizationStatus()
                    guard status == .authorized || status == .limited else { return nil }
                    let adapter = PhotoKitMergeAdapter()
                    // Kick a background warm-up so the cache refreshes against
                    // current PhotoKit state. The adapter's init already loaded
                    // any disk-cached buckets synchronously, so first-paint of
                    // the cloud timeline is instant on subsequent launches.
                    // First-ever launch sees cloud-only cells until warm-up
                    // finishes; the VM observes `onWarmedUp` to re-merge.
                    Task { await adapter.warmUp() }
                    return adapter
                }()
                // Resolve the library's registered root so the prefix can be
                // made relative to it. Prefer the warm folder cache the
                // sidebar already populated; fall back to a live /api/folders
                // fetch on a miss. nil root → relativePathPrefix returns nil
                // → library-wide scope (safe), never a zero-matching path.
                let libraryRoot: String?
                if let cachedRoot = CloudFoldersCache.load(server: serverID)?
                    .first(where: { $0.id == folderID })?.path {
                    libraryRoot = cachedRoot
                } else {
                    libraryRoot = (await loadCloudFoldersFor(serverID))
                        .first(where: { $0.id == folderID })?.path
                }
                let timelinePrefix = CloudSearchClient.relativePathPrefix(
                    absPath: libraryPath, libraryRoot: libraryRoot)
                cloudTimelineVM = CloudTimelineViewModel(
                    server: serverID,
                    libraryID: folderID,
                    pathPrefix: timelinePrefix,
                    searchClient: searchClient,
                    photoKitMerge: photoKitMerge)
                cloudTimelineThumbClient = CloudThumbClient(server: serverID, httpClient: httpClient)
                cloudTimelineThumbCache = CloudThumbCache()
                // Title is the friendly library name, not the URL host
                // (#782). The " — Timeline" suffix was dropped in #692 — it
                // truncated in the compact nav bar and added no information.
                libraryTitle = cloudLibraryTitle(serverID: serverID,
                                                 folderID: folderID,
                                                 libraryPath: libraryPath)
                mode = .browse
            }
        }
    }

    // MARK: - Cloud view mode

    /// Current Timeline/Folder view mode for the selected cloud library,
    /// read from the registry. Defaults to `.folder` for non-cloud
    /// selections (the trailing toggle that reads this is hidden then).
    /// Accessed during `body` so Observation re-tints the toggle when the
    /// registry's `viewMode` changes.
    var currentCloudViewMode: CloudViewMode {
        if case .cloudLibrary(let serverID, _) = librarySelection {
            return CloudServerRegistry.shared.viewMode(for: serverID)
        }
        return .folder
    }

    /// Switch the open cloud library between Timeline and Folder view.
    /// Persists the choice to the registry, then re-routes the current
    /// library through the new mode (mirrors what the sidebar toggle used
    /// to do before it moved into the header — #782). `cloudCurrentPath`
    /// preserves any subfolder the user had drilled into.
    @MainActor
    func setCloudViewMode(_ mode: CloudViewMode) {
        guard case .cloudLibrary(let serverID, let folderID) = librarySelection else { return }
        CloudServerRegistry.shared.setViewMode(mode, for: serverID)
        loadCloudLibrary(serverID: serverID,
                         folderID: folderID,
                         libraryPath: cloudCurrentPath ?? "")
    }

    // MARK: - Cloud search

    /// Toolbar magnifying-glass handler — flips the cloud search UI on/off.
    @MainActor
    func toggleSearch() {
        if isSearchActive { deactivateSearch() }
        else { activateSearch() }
    }

    /// Stand up a search session for the currently-selected cloud library.
    /// Reuses the same AuthenticatedHTTPClient for the search + thumb
    /// clients (one 401-refresh coalescer) for the VM's lifetime. No-op for
    /// non-cloud selections — the toolbar button is disabled there anyway.
    @MainActor
    func activateSearch() {
        guard case .cloudLibrary(let serverID, let folderID) = librarySelection else { return }
        let httpClient = makeAuthenticatedHTTPClient(server: serverID)
        searchVM = SearchViewModel(
            server: serverID,
            libraryID: folderID,
            searchClient: CloudSearchClient(server: serverID, httpClient: httpClient))
        searchThumbClient = CloudThumbClient(server: serverID, httpClient: httpClient)
        searchThumbCache = CloudThumbCache()
        isSearchActive = true
    }

    /// Drop the search session state without restoring the underlying view.
    /// Used when the selection itself is changing — the new selection's own
    /// load repopulates the center column, so a restore here would race it.
    @MainActor
    func tearDownSearch() {
        isSearchActive = false
        searchVM = nil
        searchThumbClient = nil
        searchThumbCache = nil
    }

    /// Tear down the search session and return to the library's normal view.
    @MainActor
    func deactivateSearch() {
        tearDownSearch()
        // Folder-mode restore: opening a search result routes through
        // `openCloudAsset`, which replaces the browse grid with the single
        // opened asset (and clears `currentSource`). Reload the directory so
        // closing search returns to the full listing rather than one cell.
        // Timeline-mode libraries keep `cloudTimelineVM` set and re-show the
        // timeline on their own, so they need no restore here.
        if cloudTimelineVM == nil,
           case .cloudLibrary(let serverID, let folderID) = librarySelection,
           let path = cloudCurrentPath {
            let httpClient = makeAuthenticatedHTTPClient(server: serverID)
            let source = CloudSource(server: serverID,
                                     folderID: folderID,
                                     libraryPath: path,
                                     httpClient: httpClient)
            Task { @MainActor in await browseVM.loadCloudDir(source, absPath: path) }
        }
    }

    /// Build the bytes-providing `AssetRef` for a cloud asset and ensure its
    /// `EditSession` exists (with a server-backed `CloudSidecarStore` so XMP
    /// edits persist back to the server), then bind the histogram client.
    ///
    /// This is the asset-resolution half of opening a cloud asset, shared by
    /// both editor entry points:
    ///   • Mac / iPad (`openCloudAsset`) flips `mode = .fullImage` and renders
    ///     the legacy `FullImageView` from the returned ref.
    ///   • iPhone (#809) appends the returned ref to the Library tab's
    ///     `NavigationStack` path so `EditorDestination → EditorView` (S5)
    ///     opens with adjustment controls — reusing the session created here,
    ///     including its `CloudSidecarStore` (the destination's fallback
    ///     `EditSession(asset:)` injects no remote store, so pre-creating the
    ///     session here is load-bearing for server-side XMP persistence).
    @MainActor
    func prepareCloudSession(_ asset: SearchAsset, server: URL) -> AssetRef {
        let httpClient = makeAuthenticatedHTTPClient(server: server)
        // libraryPath is unused for this code path — we never call
        // source.images() on a single-asset open. Pass the asset's
        // parent dir so a hypothetical navigate() lands somewhere
        // sensible.
        let parentPath = (asset.abs_path as NSString).deletingLastPathComponent
        let source = CloudSource(server: server,
                                 folderID: asset.folder_id,
                                 libraryPath: parentPath,
                                 httpClient: httpClient)
        // The cloud asset's editor id matches the web's `fs:<absPath>`
        // shape so CloudSource.thumb / rawBytes pull paths from id.
        let imageRef = ImageRef(id: asset.id, displayName: asset.filename, url: nil)
        let assetRef = AssetRef(
            displayName: asset.filename,
            hintExtension: (asset.filename as NSString).pathExtension.lowercased(),
            stableID: asset.id,
            bytesProvider: { [source, imageRef] in try await source.rawBytes(for: imageRef) }
        )
        if sessions[assetRef.id] == nil {
            let remoteStore = CloudSidecarStore(server: server, assetID: asset.id, httpClient: httpClient)
            let session = EditSession(asset: assetRef, remoteSidecarStore: remoteStore)
            sessions[assetRef.id] = session
            Task { await session.loadSidecar() }
        }
        // #633 — bind the histogram client to the asset's server so
        // InfoPanel's HistogramBlock can fetch live RGB curves. Reuses
        // the same AuthenticatedHTTPClient as the rest of the cloud
        // session to keep the 401-refresh coalescer single-flighted.
        cloudHistogramClient = CloudHistogramClient(server: server, httpClient: httpClient)
        return assetRef
    }

    /// Open the legacy FullImage editor for a cloud asset selected from
    /// CloudTimelineView / CloudSearchView. Mac / iPad entry point — the pane
    /// shell has no `NavigationStack`, so it flips `mode = .fullImage`.
    /// iPhone routes the same tap to the S5 `EditorView` via the Library
    /// tab's `NavigationStack` instead (#809) and never calls this.
    @MainActor
    func openCloudAsset(_ asset: SearchAsset, server: URL) {
        let assetRef = prepareCloudSession(asset, server: server)
        browseVM.loadSingleCloudAsset(assetRef)
        mode = .fullImage
    }
}
