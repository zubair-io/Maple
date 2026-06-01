// EditorSessionHost.swift — desktop/iPad host for the S5 `EditorView`
// (#815).
//
// The Mac/iPad pane shell opens an image into the S5 editor in its
// center column (vs the iPhone shell, which uses a NavigationStack push
// via `EditorDestination`). This host owns the `EditorState` in `@State`
// for the editor's lifetime: building it inline inside the center
// column's `body` would construct a fresh `EditorState` on every SwiftUI
// re-render, silently resetting the armed tool / group and fine-mode
// (the editor would compile clean but lose its UI state on every slider
// tick). Mirrors the lifetime contract `EditorDestination` enforces on
// iPhone.
//
// Unlike `EditorDestination`, the `EditSession` is already resolved and
// cached in `AppShell.sessions` by the `open*` action methods before the
// pane shell flips into `.editing`, so the state build is synchronous —
// no async `.task` to create the session. The state is rebuilt when the
// asset id changes (the user picks a different filmstrip sibling) so the
// editor re-arms against the new session.
//
// On dismiss it flushes the pending XMP write, matching the S5 spec
// risk #4b (undo-then-leave must persist the right value, not the stale
// pre-undo value sitting in the 750ms debounce window) — same as the
// iPhone `EditorDestination.onDisappear` path.

import SwiftUI
import MapleCore

struct EditorSessionHost: View {
    let session: EditSession
    var filmstripAssets: [AssetRef] = []
    let onDismiss: () -> Void
    let onShare: () -> Void
    var onSelectAsset: (AssetRef) -> Void = { _ in }

    /// Owned for the editor's lifetime so armed-tool / fine-mode survive
    /// re-renders. Rebuilt on `session.asset.id` change.
    @State private var state: EditorState?

    var body: some View {
        Group {
            if let state {
                EditorView(
                    state: state,
                    onDismiss: onDismiss,
                    onShare: onShare,
                    // Info lives in the persistent DetailPanel third column
                    // on the pane shell, so there's nothing extra to present.
                    onInfo: {},
                    filmstripAssets: filmstripAssets,
                    onSelectAsset: onSelectAsset
                )
            } else {
                Color.clear
            }
        }
        // Build / rebuild the EditorState when the active session changes.
        // The session already exists in AppShell.sessions, so this is a
        // synchronous identity check — no async session creation here.
        .task(id: session.asset.id) {
            state = EditorState(session: session)
        }
        .onDisappear {
            // S5 spec risk #4b — flush the debounced sidecar write before
            // tear-down so an undo-then-leave persists the right value.
            let session = self.session
            Task.detached { await session.flushPendingSidecarWrite() }
        }
    }
}
