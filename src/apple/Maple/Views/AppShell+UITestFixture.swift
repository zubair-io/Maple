// AppShell+UITestFixture.swift — UITest harness cold-start fast path.
// Extracted from AppShell.swift's `.task` body as part of the multi-PR
// AppShell split (#123, slice 6 of 6).
//
// The harness stashes a fixture URL on `MapleApp.uitestFixtureURL` via a
// launch environment variable; when present we seed the grid with that
// single asset and flip directly into the S5 editor (`.editing`) so the
// test can wait on the `canvas-render-ready` accessibility identifier the
// EditorView canvas publishes. On macOS the pane shell renders `EditorView`
// in its center column for `.editing` (#816). The UITest harness was
// migrated off the legacy `FullImageView` loupe to the S5 `.editing`/
// EditorView canvas in #820; `FullImageView` / `Mode.fullImage` itself was
// retired in #1807 once nothing else referenced it.
// The branch skips `restoreLastSource()` entirely — the harness wants a
// known empty starting state. See
// `.archived-plans/plans/2026-04-25-xcuitest-visual-harness.md`.
//
// Returning a `Bool` lets the call site in `body.task` short-circuit
// (`if await loadUITestFixtureIfPresent() { return }`) rather than nest
// the entire restore path in an `else` branch.

#if DEBUG
import SwiftUI
import MapleCore

@MainActor
extension AppShell {
    /// Returns `true` if a UITest fixture URL was present and consumed —
    /// caller should short-circuit and skip the normal source restore.
    /// Returns `false` when no fixture is configured (the normal app path).
    func loadUITestFixtureIfPresent() async -> Bool {
        guard let fixtureURL = MapleApp.uitestFixtureURL else { return false }
        // The fixture path deliberately skips `restoreLastSource()`, and with
        // it the `RenderedPreviewCache.configure(folderURL:)` call every real
        // folder-open path in `AppShell+FolderActions` makes. So the harness
        // has always run with `cacheDir == nil` — the cross-session rendered-
        // preview cache switched OFF — which is exactly why the cache-
        // poisoning regression of #1801 was structurally invisible to every
        // gate (#1805).
        //
        // Opt-in rather than unconditional: the golden and seam harnesses
        // point at the shared `test-fixtures/raws/` tree, and writing a
        // `.maple/previews/` store there would let one run's preview seed the
        // next one's canvas. Only the upgrade-scenario gate, which stages its
        // own throwaway directory, asks for the cache.
        if ProcessInfo.processInfo.environment["MAPLE_UITEST_PREVIEW_CACHE"] == "1" {
            await RenderedPreviewCache.shared.configure(
                folderURL: fixtureURL.deletingLastPathComponent())
        }
        browseVM.loadSingleAsset(url: fixtureURL)
        if let asset = browseVM.assets.first {
            let session = EditSession(asset: asset)
            sessions[asset.id] = session
            await session.loadSidecar()
            browseVM.selectedID = asset.id
            mode = .editing
        }
        return true
    }
}
#endif
