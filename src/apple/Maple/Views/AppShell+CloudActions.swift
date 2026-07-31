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

// MARK: - ResolvedCloudAsset

/// A cloud asset resolved for opening: the bytes-providing `AssetRef` plus the
/// `CloudSource` that serves its server-rendered thumb and preview.
///
/// Both halves travel together because the two surfaces need different ones.
/// The editor decodes through the ref's `bytesProvider`; **Preview dispatches
/// its image tiers on the source** — a cloud ref has no `primaryURL`, so
/// without the source `ThumbnailProvider` has no display tier and
/// `ThumbnailLoader` falls back to pulling the entire RAW (#2376). Returning
/// only the ref is what let that regression happen.
struct ResolvedCloudAsset {
    let ref: AssetRef
    let source: any ImageSource
}

@MainActor
extension AppShell {
    @MainActor
    func makeAuthenticatedHTTPClient(server: URL) -> AuthenticatedHTTPClient {
        // Resolve the per-server session up front and capture the instance
        // (a @MainActor, Sendable class) — not `self`, not the resolver — so
        // the escaping onSignOut closure can't drag the AppShell view in.
        let session = sessionFor(server)
        return AuthenticatedHTTPClient(
            server: server,
            urlSession: .shared,
            tokensProvider: { try? TokenStore.load(server: server) },
            // Save AND mirror to the File Provider extension's shared store on
            // every rotation, so a background extension never refreshes with a
            // superseded token (→ server reuse-detection → family revoked →
            // sign-out). See CloudTokenPersistence.
            onTokensRefreshed: { try CloudTokenPersistence.persistRotated($0, server: server) },
            // A request 401'd and its refresh was rejected — the refresh token
            // is dead. Drive the OBSERVABLE AuthSession to signed-out (which
            // also clears the Keychain) rather than clearing the Keychain alone.
            // The old clear-only behavior left `session.isSignedIn` stuck true,
            // so the next request passed the cold-start guards and fired with no
            // bearer → the server's "missing bearer" 401, and the sidebar never
            // surfaced a way back in. handleAuthExpired flips the state, so the
            // sidebar shows "Sign in" and stops dispatching tokenless requests.
            onSignOut: {
                Task { @MainActor in await session.handleAuthExpired() }
            },
            refreshExecutor: BackgroundExecution()
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
        let effectiveServer = LocalNetworkResolver.shared.effectiveURL(for: url)
        let client = CloudFoldersClient(server: effectiveServer, httpClient: httpClient)
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
        let effectiveServer = LocalNetworkResolver.shared.effectiveURL(for: server)
        let client = CloudFoldersClient(server: effectiveServer, httpClient: httpClient)
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
                // #1381 — stash the target so the sign-in sheet replays this
                // folder once the user re-authenticates.
                pendingCloudReopen = PendingCloudOpen(serverID: serverID,
                                                      folderID: folderID,
                                                      libraryPath: libraryPath)
                addCloudSheetTarget = .prefilled(serverID.host ?? serverID.absoluteString)
                return
            }

            let viewMode = CloudServerRegistry.shared.viewMode(for: serverID)
            switch viewMode {
            case .folder:
                cloudTimelineVM = nil
                let httpClient = makeAuthenticatedHTTPClient(server: serverID)
                let effectiveServer = LocalNetworkResolver.shared.effectiveURL(for: serverID)
                let source = CloudSource(server: effectiveServer,
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
                    let foldersClient = CloudFoldersClient(server: effectiveServer,
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

                // #1381 — a token revoked mid-session 401s the load above; the
                // refresh fails and credentials get cleared. Re-present sign-in
                // (replaying this folder afterward) instead of stranding the
                // user on an error banner with no way back in.
                if ReauthDecision.needsSignIn(isSignedIn: session.isSignedIn,
                                              loadError: browseVM.loadError) {
                    pendingCloudReopen = PendingCloudOpen(serverID: serverID,
                                                          folderID: folderID,
                                                          libraryPath: libraryPath)
                    if addCloudSheetTarget == nil {
                        addCloudSheetTarget = .prefilled(serverID.host ?? serverID.absoluteString)
                    }
                    return
                }

                libraryTitle = cloudLibraryTitle(serverID: serverID,
                                                 folderID: folderID,
                                                 libraryPath: cloudCurrentPath ?? libraryPath)
                mode = .browse
                // The dir listing above just replaced the visible asset list
                // wholesale — drop any session left over from whatever
                // folder/library was open before (#2038).
                pruneSessionsForNewAssetList()
            case .timeline:
                browseVM.clear()
                // Single AuthenticatedHTTPClient shared by the search +
                // thumb clients for the lifetime of this Timeline VM.
                // Defeats the 401-refresh-storm bug if many cells hit
                // expired tokens at once — only one /api/auth/refresh
                // call goes out, all callers wait on the same continuation.
                let httpClient = makeAuthenticatedHTTPClient(server: serverID)
                let effectiveServer = LocalNetworkResolver.shared.effectiveURL(for: serverID)
                let searchClient = CloudSearchClient(server: effectiveServer, httpClient: httpClient)
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
                cloudTimelineThumbClient = CloudThumbClient(server: effectiveServer, httpClient: httpClient)
                cloudTimelineThumbCache = CloudThumbCache()
                // Title is the friendly library name, not the URL host
                // (#782). The " — Timeline" suffix was dropped in #692 — it
                // truncated in the compact nav bar and added no information.
                libraryTitle = cloudLibraryTitle(serverID: serverID,
                                                 folderID: folderID,
                                                 libraryPath: libraryPath)
                mode = .browse
                // Timeline mode renders from `cloudTimelineVM`, not
                // `browseVM.assets` (cleared above by `browseVM.clear()`), and
                // has no per-cell `ensureSession` priming — so the keep-set
                // here is just the actively-open editor asset, if any (#2038).
                pruneSessionsForNewAssetList()
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
        let effectiveServer = LocalNetworkResolver.shared.effectiveURL(for: serverID)
        searchVM = SearchViewModel(
            server: serverID,
            libraryID: folderID,
            searchClient: CloudSearchClient(server: effectiveServer, httpClient: httpClient))
        searchThumbClient = CloudThumbClient(server: effectiveServer, httpClient: httpClient)
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
            let source = CloudSource(server: LocalNetworkResolver.shared.effectiveURL(for: serverID),
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
    ///   • Mac / iPad (`openCloudAsset`) flips `mode = imageOpenMode`
    ///     (`.preview`, Fast Preview §1) and renders the Preview surface from
    ///     the returned ref.
    ///   • iPhone (#809) appends the returned ref to the Library tab's
    ///     `NavigationStack` path so `EditorDestination → EditorView` (S5)
    ///     opens with adjustment controls — reusing the session created here,
    ///     including its `CloudSidecarStore` (the destination's fallback
    ///     `EditSession(asset:)` injects no remote store, so pre-creating the
    ///     session here is load-bearing for server-side XMP persistence).
    @MainActor
    func prepareCloudSession(_ asset: SearchAsset, server: URL) -> ResolvedCloudAsset {
        let httpClient = makeAuthenticatedHTTPClient(server: server)
        let effectiveServer = LocalNetworkResolver.shared.effectiveURL(for: server)
        // libraryPath is unused for this code path — we never call
        // source.images() on a single-asset open. Pass the asset's
        // parent dir so a hypothetical navigate() lands somewhere
        // sensible.
        let parentPath = (asset.abs_path as NSString).deletingLastPathComponent
        let source = CloudSource(server: effectiveServer,
                                 folderID: asset.folder_id,
                                 libraryPath: parentPath,
                                 httpClient: httpClient)
        // The cloud asset's editor id matches the web's `fs:<absPath>`
        // shape so CloudSource.thumb / rawBytes pull paths from id.
        let imageRef = ImageRef(id: asset.id, displayName: asset.filename, url: nil)

        // #822 — observable download progress for the determinate bar the
        // editor shows while the remote bytes arrive. Seeded with the
        // catalog `size` so the bar is determinate from the first frame even
        // before the HTTP response headers land; the server's Content-Length
        // refines it once known.
        let progress = DownloadProgress(expectedBytes: asset.size)

        // The pipeline calls `bytesProvider` more than once per open (native-
        // size seed, fast decode, refine). Memoize the fetch behind a single
        // shared `Task<Data, Error>` so the asset downloads exactly once, the
        // progress count comes from one stream (no concurrent writers
        // corrupting it), and later calls reuse the in-memory bytes. The
        // progress callback hops to the main actor (where `DownloadProgress`
        // lives) and is naturally throttled by URLSession's chunked delegate
        // cadence (one callback per network read, not per byte).
        let expectedTotal = asset.size
        let downloadBox = CloudByteDownloadBox(
            source: source, imageRef: imageRef,
            expectedTotal: expectedTotal, progress: progress)
        let assetRef = AssetRef(
            displayName: asset.filename,
            hintExtension: (asset.filename as NSString).pathExtension.lowercased(),
            stableID: asset.id,
            bytesProvider: { try await downloadBox.bytes() }
        )
        if sessions[assetRef.id] == nil {
            let remoteStore = CloudSidecarStore(server: effectiveServer, assetID: asset.id, httpClient: httpClient)
            // #2009 — developed-preview uploads to the same canonical
            // `<filename>.avif` the server serves, keyed on the asset's
            // server-side absolute path (the same save model as the XMP).
            let previewSink = CloudDisplayPreviewSink(
                server: effectiveServer, assetPath: asset.abs_path, httpClient: httpClient)
            let session = EditSession(asset: assetRef,
                                      remoteSidecarStore: remoteStore,
                                      remotePreviewSink: previewSink,
                                      downloadProgress: progress)
            sessions[assetRef.id] = session
            Task { await session.loadSidecar() }
        }
        // #633 — bind the histogram client to the asset's server so
        // InfoPanel's HistogramBlock can fetch live RGB curves. Reuses
        // the same AuthenticatedHTTPClient as the rest of the cloud
        // session to keep the 401-refresh coalescer single-flighted.
        cloudHistogramClient = CloudHistogramClient(server: effectiveServer, httpClient: httpClient)
        // Same server + client feed the InfoPanel enrichment section
        // (description / OCR / transcript) via `GET /api/assets/:id`.
        cloudAssetDetailClient = CloudAssetDetailClient(
          server: effectiveServer, httpClient: httpClient)
        return ResolvedCloudAsset(ref: assetRef, source: source)
    }

    /// Open a cloud asset (selected from CloudTimelineView / CloudSearchView)
    /// in the editor. Mac / iPad pane-shell entry point — the pane shell has
    /// no `NavigationStack`, so it flips `mode` to the in-pane editor. On
    /// Mac/iPad that's the S5 `EditorView` (`.editing`); `imageOpenMode`
    /// resolves it (#815). iPhone routes the same tap to the S5 `EditorView`
    /// via the Library tab's `NavigationStack` push instead (#809) and never
    /// calls this.
    @MainActor
    func openCloudAsset(_ asset: SearchAsset, server: URL) {
        let resolved = prepareCloudSession(asset, server: server)
        // The source rides along so Preview can serve `/api/fs/thumb` +
        // `/api/fs/preview` instead of downloading the RAW (#2376).
        browseVM.loadSingleCloudAsset(resolved.ref, source: resolved.source)
        mode = imageOpenMode
    }
}

#if os(iOS)
// MARK: - iPhone global Search tab session

/// Everything the iPhone Search tab needs: an account-wide SearchViewModel
/// plus a thumb client/cache, all sharing one AuthenticatedHTTPClient.
struct PhoneSearchSession {
    let server: URL
    let vm: SearchViewModel
    let thumbClient: CloudThumbClient
    let thumbCache: CloudThumbCache
}

@MainActor
extension AppShell {
    /// Resolve the cloud server the global phone Search tab queries: the
    /// currently-open cloud library's server if there is one, else the first
    /// connected cloud account. nil → no cloud account → empty state.
    func resolveSearchServerURL() -> URL? {
        if case .cloudLibrary(let serverID, _) = librarySelection { return serverID }
        return CloudServerRegistry.shared.servers.first
    }

    /// Stable identity for the resolved server. Drives the Search tab's
    /// `.task(id:)` so the session rebuilds when the active account changes
    /// (open a cloud library, sign in). nil → empty state.
    var phoneSearchServerKey: String? { resolveSearchServerURL()?.absoluteString }

    /// Build an account-wide (no libraryID) search session for the resolved
    /// server. Bootstraps the auth session first (cold-start keychain
    /// restore) so the first query carries a bearer token — same dance as
    /// `loadCloudLibrary`. nil when no cloud account is connected/signed-in.
    func makePhoneSearchSession() async -> PhoneSearchSession? {
        guard let serverID = resolveSearchServerURL() else { return nil }
        let session = sessionFor(serverID)
        if !session.isSignedIn { await session.bootstrapAndRestore() }
        guard session.isSignedIn else { return nil }

        let httpClient = makeAuthenticatedHTTPClient(server: serverID)
        let effectiveServer = LocalNetworkResolver.shared.effectiveURL(for: serverID)
        let vm = SearchViewModel(
            server: serverID,
            libraryID: nil, // account-wide
            searchClient: CloudSearchClient(server: effectiveServer, httpClient: httpClient))
        return PhoneSearchSession(
            server: serverID,
            vm: vm,
            thumbClient: CloudThumbClient(server: effectiveServer, httpClient: httpClient),
            thumbCache: CloudThumbCache())
    }
}
#endif
