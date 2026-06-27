// DocumentOpenRouter.swift — file-document open router (`open -a "Maple
// Exposure" photo.dng`, "Open With Maple" from Finder, drag-onto-dock).
//
// Counterpart to `DeepLinkRouter` (which handles `maple://` URL-scheme deep
// links). `MapleApp`'s `.onOpenURL` routes FILE urls here and custom-scheme
// urls to `DeepLinkRouter`. `AppShell` consumes the pending file URL via
// `consume()` from its cold-start `.task` and observes `pendingFileURL` for
// warm-launch deliveries (the same two-path pattern the deep-link router uses).
//
// ## Why this is the fix for the sandboxed un-scoped-path decode failure (#1589)
//
// The app is sandboxed with only `files.user-selected` / `bookmarks.app-scope`
// access, and the Rust FFI reads the RAW BY PATH inside a
// `startAccessingSecurityScopedResource()` bracket on `AssetRef.scopeParentURL`.
// A bare path (the old `MAPLE_UITEST_FIXTURE` env-var URL, or any hand-built
// `URL(fileURLWithPath:)`) carries no security scope, so the claim returns
// false and the sandbox denies the read → nil decode → black canvas. A document
// opened through LaunchServices, by contrast, arrives WITH a security-scoped
// grant on the file — exactly what the decode bracket needs. We claim and hold
// that scope here, and `AppShell` builds the `AssetRef` with `scopeParentURL`
// set to the opened file URL so every downstream read succeeds.

import Foundation
import OSLog
import Observation

private let docOpenLog = Logger(subsystem: "app.justmaple.aperture", category: "document-open")

@MainActor
@Observable
final class DocumentOpenRouter {
    static let shared = DocumentOpenRouter()

    /// The most recently opened file URL, awaiting consumption by `AppShell`.
    /// Observable so the shell re-evaluates its warm-launch `.onChange(of:)`
    /// on each delivery. Cleared by `consume()`.
    private(set) var pendingFileURL: URL?

    /// The security-scoped URL whose access we are currently holding. Held for
    /// the lifetime of the open (released only when superseded by a newer open)
    /// so reads outside the per-call `startAccessingSecurityScopedResource`
    /// brackets — thumbnailing, histogram, the FFI decode — all stay inside a
    /// live grant. `nil` when the URL wasn't security-scoped (e.g. a dev build
    /// with the sandbox off, where the read works without a claim anyway).
    @ObservationIgnored private var heldScope: URL?

    private init() {}

    /// Claim the LaunchServices security scope for an opened file and stash it
    /// for the shell. Non-file URLs are ignored (those are `maple://` deep
    /// links handled by `DeepLinkRouter`). At most one opened-document grant is
    /// alive at a time, and every `startAccessingSecurityScopedResource()` is
    /// balanced by exactly one `stop` (re-claiming the same URL without
    /// releasing the prior grant would leave the retain count unbalanced and
    /// leak the sandbox resource).
    func handle(_ url: URL) {
        guard url.isFileURL else { return }
        // Same file re-opened while its grant is still held: reuse it. A second
        // `start` without a matching `stop` leaks the grant, so just re-stash
        // the URL so the shell re-opens it.
        if heldScope == url {
            pendingFileURL = url
            docOpenLog.notice(
                "document re-open \(url.lastPathComponent, privacy: .public) — reusing held security scope")
            return
        }
        // Different file (or nothing held): release the previous grant before
        // claiming the new one, keeping start/stop balanced.
        if let prev = heldScope {
            prev.stopAccessingSecurityScopedResource()
        }
        let granted = url.startAccessingSecurityScopedResource()
        heldScope = granted ? url : nil
        pendingFileURL = url
        docOpenLog.notice(
            "document open \(url.lastPathComponent, privacy: .public) — security-scope granted=\(granted)")
    }

    /// Atomically read + clear the pending file URL. Returns `nil` when nothing
    /// is queued. Idempotent — safe to call repeatedly without a new open.
    func consume() -> URL? {
        let url = pendingFileURL
        pendingFileURL = nil
        return url
    }
}
