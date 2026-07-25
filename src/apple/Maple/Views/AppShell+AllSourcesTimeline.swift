// AppShell+AllSourcesTimeline.swift
//
// #2271/#2273 — opens the unified cross-source Timeline: every library on
// every connected Maple Cloud server, fanned out and merged with PhotoKit
// via `AllSourcesTimelineViewModel`. Triggered by the sidebar's TIMELINE
// row (`LibrarySidebar.onSelectTimeline`).
//
// Mirrors the per-server auth/session dance `AppShell+CloudActions` already
// does for the sidebar's folder listing (`loadCloudFoldersFor`) and for the
// single-library Timeline (`loadCloudLibrary`'s `.timeline` branch) — this
// just repeats that dance once per connected server instead of once for a
// single picked library.

import SwiftUI
import OSLog
import MapleCore

private let allSourcesTimelineOpenLog = Logger(subsystem: "app.justmaple.aperture", category: "AllSourcesTimeline.Open")

@MainActor
extension AppShell {
    /// Sidebar TIMELINE row action. Selects `.allSources` immediately (so
    /// the row highlights and `librarySelection`'s `onChange` tears down
    /// whatever was previously showing), then asynchronously resolves every
    /// connected server's libraries and stands up the aggregating VM.
    @MainActor
    func openAllSourcesTimeline() {
        librarySelection = .allSources
        currentRootBookmark = nil
        tearDownSearch()
        browseVM.clear()
        libraryTitle = "Timeline"
        mode = .browse

        Task { @MainActor in
            var sources: [AllSourcesTimelineViewModel.ServerSource] = []
            for serverURL in CloudServerRegistry.shared.servers {
                // Reuses the sidebar's own folders loader — same sign-in
                // bootstrap + offline-cache-fallback dance, so a server the
                // user hasn't gotten around to signing back into yet is
                // skipped rather than stalling the whole Timeline open.
                let folders = await loadCloudFoldersFor(serverURL)
                guard !folders.isEmpty else { continue }
                let httpClient = makeAuthenticatedHTTPClient(server: serverURL)
                let effectiveServer = LocalNetworkResolver.shared.effectiveURL(for: serverURL)
                sources.append(AllSourcesTimelineViewModel.ServerSource(
                    server: serverURL,
                    libraryIDs: folders.map(\.id),
                    searchClient: CloudSearchClient(server: effectiveServer, httpClient: httpClient),
                    thumbClient: CloudThumbClient(server: effectiveServer, httpClient: httpClient)
                ))
            }

            if sources.isEmpty {
                allSourcesTimelineOpenLog.info("no signed-in server has any library — Timeline will show PhotoKit only, if authorized")
            }

            // PhotoKit half of the merge. Unlike the single-library Timeline
            // (`loadCloudLibrary`'s `.timeline` branch), this doesn't gate on
            // `BackupSettings.isConfigured` — that setting names ONE library
            // as the backup destination, which has no meaning for a view
            // that already spans every library. Authorization is the only
            // gate that still makes sense here.
            let photoKitMerge: PhotoKitMergeAdapter? = {
                let status = PhotoKitLibrary.authorizationStatus()
                guard status == .authorized || status == .limited else { return nil }
                let adapter = PhotoKitMergeAdapter()
                Task { await adapter.warmUp() }
                return adapter
            }()

            // The user may have navigated away while the above awaited
            // (folders fetch, sign-in bootstrap) — don't clobber whatever
            // they've since selected with a stale Timeline VM.
            guard librarySelection == .allSources else { return }
            allSourcesTimelineVM = AllSourcesTimelineViewModel(sources: sources, photoKitMerge: photoKitMerge)
            allSourcesTimelineThumbCache = CloudThumbCache()
            pruneSessionsForNewAssetList()
        }
    }
}
