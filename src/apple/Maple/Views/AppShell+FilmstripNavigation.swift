// AppShell+FilmstripNavigation.swift — pane-shell (iPad/Mac) filmstrip
// sibling selection (#3402).
//
// Both image surfaces mount the same vertical `FilmstripRail` on their
// leading edge — the S5 editor (`EditorView`) and the fast static
// `PreviewView` — and a tap on either strip must stay on the surface that
// hosts it. Before #3402 the editor's rail was wired to `openEditor(for:)`,
// whose tail sets `mode = imageOpenMode` (= `.preview`), so every sibling
// picked from inside the editor silently dropped the user out to Preview.
// Preview's own rail writes `browseVM.selectedID` directly (see
// `AppShellCenterColumn`) — it never primes a session, because merely
// looking at the next photo must cost nothing.
//
// Same `@State`-sharing arrangement as the sibling `AppShell+*Actions`
// extensions: `mode`, `browseVM` and `sessions` are the shell's own state.

import SwiftUI
import MapleCore

@MainActor
extension AppShell {
    /// Editor filmstrip-rail tap on the pane shell: switch the edited asset
    /// in place, keeping `mode` on the hosting surface.
    ///
    /// 1. Session bookkeeping mirrors `openEditor(for:)` — reuse the primed
    ///    session, else create one and kick its sidecar load — so
    ///    `EditorSessionHost` (which rebuilds its `EditorState` on the
    ///    asset-id change) mounts against a real session on the next frame.
    /// 2. The OUTGOING session gets the same exit bookkeeping the editor's
    ///    back button does (`onEditorDismiss` in `AppShell`): persist its
    ///    developed preview (#1879/#2009 — the GPU-live path never refreshes
    ///    the thumbnail cache on its own) and flush the debounced sidecar
    ///    write (S5 risk #4b). Both capture the session strongly, because
    ///    `browseVM.selectedID`'s `onChange` prunes every non-active session
    ///    the moment the selection moves.
    /// 3. `mode` is resolved by `AppShellVM.filmstripLandingMode` — the
    ///    editor stays the editor.
    func selectFilmstripSibling(_ asset: AssetRef) {
        let previousID = browseVM.selectedID
        guard previousID != asset.id else { return }
        if mode == .editing, let outgoing = previousID.flatMap({ sessions[$0] }) {
            Task { await outgoing.persistDisplayPreviewOnExit() }
            Task.detached { await outgoing.flushPendingSidecarWrite() }
        }
        let ensured = AppShellVM.ensureSession(for: asset, in: &sessions)
        if ensured.created {
            Task { await ensured.session.loadSidecar() }
        }
        browseVM.selectedID = asset.id
        mode = AppShellVM.filmstripLandingMode(hosting: mode)
    }
}
