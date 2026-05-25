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

                libraryTitle = serverID.host ?? serverID.absoluteString
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
                libraryTitle = (serverID.host ?? serverID.absoluteString) + " — Timeline"
                mode = .browse
            }
        }
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

    /// Open the FullImage editor for a cloud asset selected from
    /// CloudTimelineView. Builds a bytes-providing AssetRef so the Rust
    /// pipeline can decode without a local file, and injects a
    /// CloudSidecarStore so XMP edits persist back to the server.
    @MainActor
    func openCloudAsset(_ asset: SearchAsset, server: URL) {
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
        browseVM.loadSingleCloudAsset(assetRef)
        mode = .fullImage
    }
}
