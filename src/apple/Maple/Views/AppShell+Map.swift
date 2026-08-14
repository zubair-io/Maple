// AppShell+Map.swift
//
// #2830 — opens the native MapKit map view: every located photo on the
// resolved cloud server. Account-wide (no libraryID), same scoping as the
// iPhone global Search tab's session (`resolveSearchServerURL()` /
// `makePhoneSearchSession()` in AppShell+CloudActions.swift) — the map
// endpoint takes the same filter shape search does and has no per-library
// concept, so there's no reason to gate it to whichever library happens to
// be open. Triggered by the sidebar's MAP row (`LibrarySidebar.onSelectMap`).
//
// Not reusing `resolveSearchServerURL()` / `activateSearch()` directly:
// both are scoped to (or gated on) a specific `.cloudLibrary` selection —
// `resolveSearchServerURL()` is also `#if os(iOS)`-only (the iPhone Search
// tab's own file). Map flips `librarySelection` to `.map` itself, so by
// the time a pin is tapped there is no `.cloudLibrary` selection left to
// read; this file resolves + activates its own account-wide session
// instead, mirroring `makePhoneSearchSession()`'s shape (`libraryID: nil`)
// without the `#if os(iOS)` gate or the `.cloudLibrary`-only guard.
//
// Mirrors `AppShell+AllSourcesTimeline.swift`'s open-then-async-resolve
// shape: select immediately (so the row highlights and any prior session
// tears down), then asynchronously bootstrap auth and stand up the VM.

import SwiftUI
import MapleCore

@MainActor
extension AppShell {
    /// Sidebar MAP row action.
    func openMap() {
        // Capture BEFORE flipping `librarySelection` below — once it's
        // `.map` there's no `.cloudLibrary` left to read.
        let resolvedServer = resolveMapServerURL()

        librarySelection = .map
        currentRootBookmark = nil
        tearDownSearch()
        browseVM.clear()
        libraryTitle = "Map"
        mode = .browse
        mapVM = nil
        mapThumbClient = nil
        mapThumbCache = nil

        Task { @MainActor in
            guard let serverID = resolvedServer else { return }
            let session = sessionFor(serverID)
            if !session.isSignedIn { await session.bootstrapAndRestore() }
            guard session.isSignedIn else { return }
            // The user may have navigated away while the above awaited
            // (sign-in bootstrap) — don't clobber whatever they've since
            // selected with a stale map VM.
            guard librarySelection == .map else { return }

            let httpClient = makeAuthenticatedHTTPClient(server: serverID)
            let effectiveServer = LocalNetworkResolver.shared.effectiveURL(for: serverID)
            mapVM = MapViewModel(
                server: serverID,
                client: MapClustersClient(server: effectiveServer, httpClient: httpClient))
            mapThumbClient = CloudThumbClient(server: effectiveServer, httpClient: httpClient)
            mapThumbCache = CloudThumbCache()
        }
    }

    /// The server Map queries: the currently-open cloud library's server if
    /// there is one, else the first connected cloud account. `nil` → no
    /// cloud account connected → the map opens to its empty state.
    private func resolveMapServerURL() -> URL? {
        if case .cloudLibrary(let serverID, _) = librarySelection { return serverID }
        return CloudServerRegistry.shared.servers.first
    }

    /// Map pin/cluster tap → open the cloud search overlay pre-filled with
    /// the tapped cell's resolved target (mirrors `activateSearch(query:)`,
    /// the info pane's face-chip tap handler). `.hasLocationScope` covers
    /// the "cell missing placeLabel" fallback (design doc's error-states
    /// section) — landing on "everything with a location" beats a no-op
    /// tap. Builds its own account-wide (no libraryID) search session off
    /// the map's own server rather than `activateSearch()`, which requires
    /// a `.cloudLibrary` selection Map has already replaced with `.map`.
    func selectMapPlace(_ target: MapPlaceSearchTarget) {
        guard let serverID = mapVM?.server else { return }
        let httpClient = makeAuthenticatedHTTPClient(server: serverID)
        let effectiveServer = LocalNetworkResolver.shared.effectiveURL(for: serverID)
        let vm = SearchViewModel(
            server: serverID,
            libraryID: nil, // account-wide, same scope as the map itself
            searchClient: CloudSearchClient(server: effectiveServer, httpClient: httpClient))
        switch target {
        case .placeQuery(let query):
            vm.params.placeQuery = query
        case .hasLocationScope:
            vm.params.scope = "places"
        }
        searchVM = vm
        searchThumbClient = CloudThumbClient(server: effectiveServer, httpClient: httpClient)
        searchThumbCache = CloudThumbCache()
        isSearchActive = true
        Task { await vm.submit() }
    }
}
