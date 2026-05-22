// AppShell+UITestFixture.swift — UITest harness cold-start fast path.
// Extracted from AppShell.swift's `.task` body as part of the multi-PR
// AppShell split (#123, slice 6 of 6).
//
// The harness stashes a fixture URL on `MapleApp.uitestFixtureURL` via a
// launch environment variable; when present we seed the grid with that
// single asset and flip directly into Full-image mode so the test can
// wait on the `canvas-render-ready` accessibility identifier. The branch
// skips `restoreLastSource()` entirely — the harness wants a known empty
// starting state. See `.archived-plans/plans/2026-04-25-xcuitest-visual-harness.md`.
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
        browseVM.loadSingleAsset(url: fixtureURL)
        if let asset = browseVM.assets.first {
            let session = EditSession(asset: asset)
            sessions[asset.id] = session
            await session.loadSidecar()
            browseVM.selectedID = asset.id
            mode = .fullImage
        }
        return true
    }
}
#endif
