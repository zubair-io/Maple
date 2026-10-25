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
// `openMap()` doesn't reuse `resolveSearchServerURL()` / `activateSearch()`
// directly: both are scoped to (or gated on) a specific `.cloudLibrary`
// selection — `resolveSearchServerURL()` is also `#if os(iOS)`-only (the
// iPhone Search tab's own file). Map flips `librarySelection` to `.map`
// itself, so by the time a pin is tapped there is no `.cloudLibrary`
// selection left to read; this file resolves its own account-wide server
// instead, mirroring `makePhoneSearchSession()`'s shape (`libraryID: nil`)
// without the `#if os(iOS)` gate or the `.cloudLibrary`-only guard.
//
// `selectMapPlace(_:)` DOES reuse `activateSearch(server:libraryID:params:)`
// (#2886) — the explicit-server/preset-params overload in
// AppShell+CloudActions.swift exists precisely so this file's account-wide,
// `.map`-scoped tap can share the same session-building path as
// `.cloudLibrary` search, instead of hand-building its own
// `SearchViewModel`/`CloudSearchClient`/`CloudThumbClient`/`CloudThumbCache`.
//
// Mirrors `AppShell+AllSourcesTimeline.swift`'s open-then-async-resolve
// shape: select immediately (so the row highlights and any prior session
// tears down), then asynchronously bootstrap auth and stand up the VM.

import MapleCore
import SwiftUI

@MainActor
extension AppShell {
  /// Sidebar MAP row action. `server` pins the account to query — a
  /// reopen after signing in to that server (#5033) — instead of resolving
  /// it from the current selection.
  func openMap(server: URL? = nil) {
    // Capture BEFORE flipping `librarySelection` below — once it's
    // `.map` there's no `.cloudLibrary` left to read.
    let resolvedServer = server ?? resolveMapServerURL()

    librarySelection = .map
    currentRootBookmark = nil
    tearDownSearch()
    browseVM.clear()
    libraryTitle = "Map"
    mode = .browse
    mapVM = nil
    mapThumbClient = nil
    mapThumbCache = nil

    guard let serverID = resolvedServer else {
      // No connected cloud account at all — `AppShellCenterColumn`
      // renders `MapEmptyState(.noAccount)` (#2848) instead of
      // falling through to the browse grid.
      mapUnavailableReason = .noAccount
      return
    }
    // Bootstrapping an already-connected account's token — shown as a
    // brief spinner (#2848) rather than falling through to the grid
    // while this awaits below.
    mapUnavailableReason = .connecting

    Task { @MainActor in
      let session = sessionFor(serverID)
      if !session.isSignedIn { await session.bootstrapAndRestore() }
      // The user may have navigated away while the above awaited
      // (sign-in bootstrap) — don't clobber whatever they've since
      // selected with a stale map VM or unavailable-reason.
      guard librarySelection == .map else { return }

      // Bootstrap only restores an already-persisted token; it does not
      // prompt. A server that needs fresh credentials shows
      // `MapEmptyState(.signInRequired)`, whose Sign in button routes to
      // `signInForMap(_:)` (#5033) rather than presenting the sheet
      // unasked on a sidebar tap.
      if let reason = MapAvailability.reason(server: serverID, isSignedIn: session.isSignedIn) {
        mapUnavailableReason = reason
        return
      }

      let httpClient = makeAuthenticatedHTTPClient(server: serverID)
      let effectiveServer = LocalNetworkResolver.shared.effectiveURL(for: serverID)
      mapVM = MapViewModel(
        server: serverID,
        client: MapClustersClient(server: effectiveServer, httpClient: httpClient))
      mapThumbClient = CloudThumbClient(server: effectiveServer, httpClient: httpClient)
      mapThumbCache = CloudThumbCache()
      // Clear the `.connecting` placeholder now that `mapVM` is ready —
      // `AppShellCenterColumn` already prefers a non-nil `mapVM` over
      // `mapUnavailableReason`, so this has no visible effect, but
      // leaving it stale would contradict this property's own doc
      // comment ("`nil` only while `mapVM` is non-nil ...") the next
      // time something reads it (#2848 review).
      mapUnavailableReason = nil
    }
  }

  /// The Map empty state's Sign in button (#5033): the same prefilled
  /// re-auth sheet the sidebar's "Sign in" presents.
  func signInForMap(_ server: URL) {
    // A folder reopen left over from an earlier, abandoned sign-in must not
    // replay and pull the user off the Map.
    pendingCloudReopen = nil
    addCloudSheetTarget = .prefilled(CloudHost.signInPrefill(for: server))
  }

  /// Called after any completed sign-in, from the Map's own button or the
  /// sidebar: a Map still showing a sign-in or no-account message for that
  /// server rebuilds itself instead of waiting for the user to navigate away
  /// and back (#5033).
  func reopenMapIfAwaitingSignIn(to server: URL) {
    guard librarySelection == .map,
      mapUnavailableReason?.reopensAfterSignIn(to: server) == true
    else { return }
    openMap(server: server)
  }

  /// The server Map queries: the currently-open cloud library's server if
  /// there is one, else the first connected cloud account. `nil` → no
  /// cloud account connected → `openMap()` sets `mapUnavailableReason =
  /// .noAccount` and `AppShellCenterColumn` renders `MapEmptyState`
  /// instead of `MapView` (#2848).
  private func resolveMapServerURL() -> URL? {
    if case .cloudLibrary(let serverID, _) = librarySelection { return serverID }
    return CloudServerRegistry.shared.servers.first
  }

  /// Map pin/cluster tap → open the cloud search overlay pre-filled with
  /// the tapped cell's resolved target (mirrors `activateSearch(query:)`,
  /// the info pane's face-chip tap handler). `.hasLocationScope` covers
  /// the "cell missing placeLabel" fallback (design doc's error-states
  /// section) — landing on "everything with a location" beats a no-op
  /// tap.
  ///
  /// Seeds the new session from `mapVM.filter` — the SAME filter the map
  /// itself queried `/api/map/clusters` with — before layering the tap's
  /// place/scope on top, so a pin tap narrows the active filter (date
  /// range, camera, …) rather than silently discarding it back to
  /// "everything, everywhere" — `MapPlaceSearchTarget.searchParams(seededFrom:)`
  /// (MapleCloudKit) is the pure, unit-tested composition of that chain.
  /// Delegates the actual session-building (client/thumb-cache setup,
  /// `isSearchActive` flip) to `activateSearch(server:libraryID:params:)`
  /// (#2886) — this function's only job is resolving the map's own
  /// account-wide (no libraryID) server and seeding the params.
  ///
  /// On iPhone this seeds the production Search tab instead (#3163) —
  /// same reasoning as the widget deep link
  /// (`AppShell+DeepLink.swift.navigateToSearch`): the mac/iPad overlay
  /// this function otherwise activates is a second, duplicated search UI
  /// on the phone, which already has `PhoneSearchTab`.
  func selectMapPlace(_ target: MapPlaceSearchTarget) {
    guard let mapVM else { return }
    let params = target.searchParams(seededFrom: mapVM.filter)
    #if os(iOS)
      if MapleShellKind.current == .phoneTab {
        switchToPhoneSearchTab(seeding: params, libraryID: nil)
        return
      }
    #endif
    activateSearch(server: mapVM.server, libraryID: nil, params: params)
    Task { await searchVM?.submit() }
  }
}
