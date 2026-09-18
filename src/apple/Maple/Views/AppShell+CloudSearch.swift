// AppShell+CloudSearch.swift — Maple Cloud search surfaces, split out of
// AppShell+CloudActions.swift (#3773; the file-budget headroom gate, #2311,
// is why it moved).
//
// Contents:
//   • toggleSearch / activateSearch(…) / tearDownSearch / deactivateSearch
//     — the mac/iPad `CloudSearchView` overlay against a cloud library
//   • PhoneSearchSession + resolveSearchServerURL / makePhoneSearchSession
//     — the iPhone global Search tab's account-wide session
//
// Every entry point honours `FeatureFlags.isMapleCloudEnabled` (#3773):
// `searchAvailable` hides the toolbar button and `activateSearch()` refuses
// to stand up a session, so neither the magnifying glass nor the info-pane
// face chips can open a cloud search overlay on a release build.

import MapleCore
import SwiftUI

@MainActor
extension AppShell {
    // MARK: - Cloud search

    /// Toolbar magnifying-glass handler — flips the cloud search UI on/off.
    @MainActor
    func toggleSearch() {
        if isSearchActive { deactivateSearch() }
        else { activateSearch() }
    }

    /// Stand up a search session for `serverID`, scoped to `libraryID` (nil
    /// = account-wide, the scope Map uses), seeded with `params`. One
    /// `AuthenticatedHTTPClient` backs the search + thumb clients (one
    /// 401-refresh coalescer) for the VM's lifetime.
    ///
    /// The shared path both cloud-library search (`activateSearch()` below)
    /// and the Map pin/cluster tap (`selectMapPlace`, `AppShell+Map.swift`)
    /// build their session through (#2886) — the no-args overload is gated
    /// on a `.cloudLibrary` selection, which Map replaces with `.map`, so
    /// this one takes server/scope explicitly instead.
    @MainActor
    func activateSearch(server serverID: URL, libraryID: String?, params: SearchParams? = nil) {
        let httpClient = makeAuthenticatedHTTPClient(server: serverID)
        let effectiveServer = LocalNetworkResolver.shared.effectiveURL(for: serverID)
        let vm = SearchViewModel(
            server: serverID,
            libraryID: libraryID,
            searchClient: CloudSearchClient(server: effectiveServer, httpClient: httpClient))
        // `SearchParams.libraryID` — not the argument above — is what hits
        // the wire (`listQueryItems()`), so force it to match: a caller-
        // seeded `params` can never silently search the wrong scope.
        var resolvedParams = params ?? vm.params
        resolvedParams.libraryID = libraryID
        vm.params = resolvedParams
        searchVM = vm
        searchThumbClient = CloudThumbClient(server: effectiveServer, httpClient: httpClient)
        searchThumbCache = CloudThumbCache()
        isSearchActive = true
    }

    /// Stand up a search session for the currently-selected cloud library.
    /// No-op for non-cloud selections — the toolbar button is disabled there
    /// anyway.
    @MainActor
    func activateSearch() {
        guard FeatureFlags.isMapleCloudEnabled else { return }
        guard case .cloudLibrary(let serverID, let folderID) = librarySelection else { return }
        activateSearch(server: serverID, libraryID: folderID)
    }

    /// Open the cloud search overlay pre-filled with `query` and run it (#2518).
    /// Used by the info pane's tappable face chips on mac/iPad. Best-effort:
    /// `activateSearch()` only stands up a session for a cloud-library
    /// selection, so this no-ops for non-cloud selections (the chip tap then
    /// does nothing rather than searching the wrong scope).
    @MainActor
    func activateSearch(query: String) {
        activateSearch()
        guard isSearchActive else { return }
        searchVM?.params.placeQuery = query
        Task { await searchVM?.submit() }
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
