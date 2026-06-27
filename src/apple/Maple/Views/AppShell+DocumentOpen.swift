// AppShell+DocumentOpen.swift — consume `DocumentOpenRouter.shared` and open
// the document in the editor.
//
// Mirrors AppShell+DeepLink: consumed from `AppShell.body` in two places —
//   • `.task` (cold start), after `restoreLastSource()`, so an opened document
//     wins over the restored grid; and
//   • `.onChange(of: DocumentOpenRouter.shared.pendingFileURL)` (warm launch),
//     when the user opens a file while the app is already foregrounded.
//
// The opened URL carries a LaunchServices security-scope grant on the FILE
// (claimed + held by `DocumentOpenRouter`), so we build the single-asset
// `AssetRef` with `scopeParentURL` set to the file URL itself — that is the URL
// the sandboxed FFI read claims scope on, which is what lets a sandboxed open
// of a RAW outside the container actually decode instead of going black (#1589).

import SwiftUI
import MapleCore
import OSLog

private let docOpenShellLog = Logger(subsystem: "app.justmaple.aperture", category: "document-open")

extension AppShell {
    /// Pulls `DocumentOpenRouter.shared.consume()` and opens the file in the
    /// editor. No-op when nothing is queued — idempotent, so calling it again
    /// without a new open is a fast nil-check.
    @MainActor
    func consumePendingOpenedDocument() {
        guard let url = DocumentOpenRouter.shared.consume() else { return }
        // Scope the read claim on the opened file URL itself (LaunchServices
        // grants security scope on the file, not its parent directory).
        browseVM.loadSingleAsset(url: url, scopeParentURL: url)
        guard let asset = browseVM.assets.first else {
            docOpenShellLog.error("document open \(url.lastPathComponent, privacy: .public) — no asset after load")
            return
        }
        docOpenShellLog.notice("document open \(url.lastPathComponent, privacy: .public) — opening editor")
        openEditor(for: asset)
    }
}
