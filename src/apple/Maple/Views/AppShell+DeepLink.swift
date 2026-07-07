// AppShell+DeepLink.swift — consume `DeepLinkRouter.shared` and route
// to the requested destination.
//
// Called from two places in `AppShell.body`:
//
//   • `.task` (cold start) — runs AFTER `restoreLastSource()` so the
//     deep link wins over the restored selection. Spec §2.
//   • `.onChange(of: DeepLinkRouter.shared.pendingDestination)`
//     (warm launch) — fires when an `.onOpenURL` arrives while the app
//     is foregrounded.
//
// Resolution today is intentionally minimal — S5 EditorView hasn't
// merged yet, so `.image(id:)` can't push a real Editor; we log + fall
// back to the Library tab to satisfy the silent-fallback rule. The
// scaffolding is in place so S5 wires its real `openEditor` here in
// one diff.
//
// Spec: docs/design/responsive-program/deep-links.md §3.
// Closes #624.

import SwiftUI
import MapleCore
import OSLog

private let deepLinkLog = Logger(subsystem: "app.justmaple.aperture", category: "deeplink")

extension AppShell {
    /// Pulls `DeepLinkRouter.shared.consume()` and dispatches. No-op
    /// when nothing is queued. Idempotent — calling repeatedly without
    /// a new `.onOpenURL` is a fast nil-check.
    @MainActor
    func consumePendingDeepLink() {
        guard let destination = DeepLinkRouter.shared.consume() else { return }
        switch destination {
        case .image(let id):
            navigateToImage(id: id)
        case .source(let id):
            navigateToSource(id: id)
        }
    }

    /// `maple://image/{id}` handler.
    ///
    /// Dismisses any active sheet, switches to the Library tab, then
    /// resolves `id` → `AssetRef` via `browseVM.assets`. If a source
    /// is mid-load (cold start, cloud restore) the resolution defers
    /// until loading completes, then retries once — so the deep link
    /// isn't silently dropped if the asset list isn't ready yet. Falls
    /// back to the Library tab if the id is still unresolvable.
    ///
    /// Per spec §2 silent-fallback: no crash, no error UI on miss.
    @MainActor
    private func navigateToImage(id: String) {
        dismissAnyActiveSheet()
        switchToLibraryTab()

        Task { @MainActor in
            await resolveAndOpenImage(id: id)
        }
    }

    /// Resolution kernel. Awaits a mid-load source if necessary (bounded to
    /// 5 s), then opens the editor or falls back silently. Extracted so the
    /// body of `navigateToImage` stays readable and the defer logic is
    /// testable in isolation.
    ///
    /// `id` is typically a filesystem path — logged at `.private` to avoid
    /// exposing home-directory names in device log streams.
    @MainActor
    private func resolveAndOpenImage(id: String) async {
        // If the source is still loading (cloud restore on cold start),
        // wait up to 5 s for it to settle before attempting resolution.
        // Polling interval: 100 ms — negligible UX cost, avoids the race
        // where browseVM.assets is empty when the deep link fires.
        let deadline = Date().addingTimeInterval(5)
        while browseVM.isLoading && Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000) // 100 ms
        }

        // id is often a filesystem path (may contain username / home dir)
        // so log it as .private to avoid leaking PII into device logs.
        if let asset = browseVM.assets.first(where: { $0.stableID == id }) {
            deepLinkLog.info("deep-link image id=\(id, privacy: .private) — resolved, opening editor")
            openEditor(for: asset)
        } else {
            deepLinkLog.info("deep-link image id=\(id, privacy: .private) — not found in current assets, routing to Library")
        }
    }

    /// `maple://source/{id}` handler.
    ///
    /// Switches to the Library tab and resolves the `id` string to a
    /// `LibrarySelection`. Resolution order:
    ///   1. PhotoKit Filters (all, favorites, picks, rejects)
    ///   2. PhotoKit Albums (by localIdentifier)
    ///   3. Local folders (by absolute path)
    ///   4. Maple Cloud libraries (by folder ObjectId)
    ///   5. SMB shares (by user@host/share or host/share)
    ///
    /// Per spec §6 Q1: explicit-link semantics — show the source's
    /// grid, do NOT auto-restore the last-viewed image inside it.
    @MainActor
    private func navigateToSource(id: String) {
        deepLinkLog.info("deep-link source id=\(id, privacy: .public)")
        dismissAnyActiveSheet()
        switchToLibraryTab()

        // 1. PhotoKit Filters
        if let filter = resolvePhotoKitFilter(id: id) {
            loadPhotos(filter: filter)
            return
        }

        // 2. PhotoKit Albums
        let status = PhotoKitLibrary.authorizationStatus()
        if status == .authorized || status == .limited {
            if let album = PhotoKitLibrary.userAlbums().first(where: { $0.id == id }) {
                loadPhotos(filter: .album(id: album.id, title: album.title))
                return
            }
        }

        // 3. Local folders
        if let folder = SavedFolderStore.load().first(where: { $0.path == id }) {
            openSavedFolder(folder)
            return
        }

        // 4. Maple Cloud libraries (cached lookup)
        for serverURL in CloudServerRegistry.shared.servers {
            if let folders = CloudFoldersCache.load(server: serverURL),
               let folder = folders.first(where: { $0.id == id }) {
                loadCloudLibrary(serverID: serverURL, folderID: folder.id, libraryPath: folder.path)
                return
            }
        }

        // 5. SMB shares (async lookup)
        Task { @MainActor in
            let shares = await SMBCredentialStore.shared.savedShares()
            if let share = shares.first(where: {
                "\($0.username)@\($0.host)/\($0.share)" == id || "\($0.host)/\($0.share)" == id
            }) {
                connectSavedSMB(share)
                return
            }
            deepLinkLog.error("deep-link source id=\(id, privacy: .public) not found")
        }
    }

    private func resolvePhotoKitFilter(id: String) -> PhotoKitFilter? {
        switch id.lowercased() {
        case "all", "all-photos": return .all
        case "favorites":         return .favorites
        case "picks":             return .picks
        case "rejects":           return .rejects
        default:                  return nil
        }
    }

    /// Dismiss any open drawer/sheet so the deep-link destination
    /// renders cleanly. Delegates to `AppShell.dismissAllTransientUI()`
    /// (defined in `AppShell.swift`) — the canonical helper can touch
    /// the `private` state vars (`showSettings`, `showExport`,
    /// `isDrawerOpen`) that this extension can't see. Per spec §2
    /// warm-launch behavior.
    @MainActor
    private func dismissAnyActiveSheet() {
        dismissAllTransientUI()
    }

    /// Flip the phone tab shell to the Library tab. No-op on Mac/iPad
    /// (those shells don't use the tab @AppStorage key). The key is
    /// `cm.tab.shell` — same one `PhoneTabShell` reads via
    /// `@AppStorage`. SwiftUI propagates the change automatically.
    @MainActor
    private func switchToLibraryTab() {
        UserDefaults.standard.set("library", forKey: "cm.tab.shell")
    }
}
