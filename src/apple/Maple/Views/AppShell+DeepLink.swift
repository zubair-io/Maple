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
    /// S5 EditorView is not merged at the time this lands, so we can't
    /// push `EditorView(asset:)` onto the active tab's NavigationStack
    /// per the spec. Stub behavior: log the request + dismiss any
    /// active iPhone drawer + flip the phone shell to the Library tab
    /// (where the asset will eventually surface). The spec's silent-
    /// fallback contract is satisfied: no crash, no error UI.
    ///
    /// When S5 lands the implementation here becomes:
    ///   1. Resolve `id` → `AssetRef` via the active source's index
    ///      (or fall back to Library root + toast if unknown).
    ///   2. `openEditor(for: ref)` to push the editor onto the active
    ///      tab's NavigationStack (phone) or open Editor in the main
    ///      pane (tablet/desktop).
    @MainActor
    private func navigateToImage(id: String) {
        deepLinkLog.info("deep-link image id=\(id, privacy: .public) — S5 EditorView pending, routing to Library")
        dismissAnyActiveSheet()
        switchToLibraryTab()
        // TODO(#577 S5): resolve id → AssetRef and call openEditor(for:).
    }

    /// `maple://source/{id}` handler.
    ///
    /// Switches to the Library tab and asks the source layer to select
    /// `id`. The actual source-id → `LibrarySelection` mapping lives in
    /// the source registries (CloudServerRegistry, SavedFolderStore,
    /// SMBCredentialStore). Until S1b ships the unified source-picker
    /// resolver, we log + fall back so the link doesn't crash.
    ///
    /// Per spec §6 Q1: explicit-link semantics — show the source's
    /// grid, do NOT auto-restore the last-viewed image inside it.
    @MainActor
    private func navigateToSource(id: String) {
        deepLinkLog.info("deep-link source id=\(id, privacy: .public) — S1b source resolver pending, routing to Library")
        dismissAnyActiveSheet()
        switchToLibraryTab()
        // TODO(#577 S1b): resolve id → LibrarySelection and apply.
    }

    /// Dismiss any open drawer/sheet so the deep-link destination
    /// renders cleanly. Per spec §2 warm-launch behavior.
    @MainActor
    private func dismissAnyActiveSheet() {
        showSMBSheet = false
        addCloudSheetTarget = nil
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
