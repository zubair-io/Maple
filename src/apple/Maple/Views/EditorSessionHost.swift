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
    /// Source the filmstrip assets came from — forwarded to `EditorView`
    /// so the strip's cells can resolve thumbnails via `ThumbnailLoader`
    /// (the sourceless thumb path needs it for cloud / self-hosted
    /// libraries; filesystem assets load with `nil`). #875 item 4a.
    var filmstripSource: (any ImageSource)? = nil
    let onDismiss: () -> Void
    let onShare: () -> Void
    /// Reveals the DetailPanel inspector column. On the pane shell the
    /// info/develop surface IS that persistent third column (not the
    /// iPhone-only Info sheet), so the editor's Info button just ensures
    /// it's visible.
    var onInfo: () -> Void = {}
    var onSelectAsset: (AssetRef) -> Void = { _ in }

    /// Owned for the editor's lifetime so armed-tool / fine-mode survive
    /// re-renders. Rebuilt on `session.asset.id` change.
    @State private var state: EditorState?

    /// The asset id the current `state` was built for. `@State` persists
    /// across SwiftUI updates, but the `.task(id:)` that rebuilds `state`
    /// runs *after* the new body is computed — so on the frame where
    /// `session` flips to a sibling, `state` still holds the PREVIOUS
    /// asset's `EditorState`. Gating `EditorView` on `builtAssetID ==
    /// session.asset.id` means we render the placeholder (not the stale
    /// editor) for that one transient frame, never the wrong asset.
    /// Set together with `state` inside the same `.task` closure so the
    /// two can never disagree.
    @State private var builtAssetID: UUID?

    var body: some View {
        Group {
            // Only render the editor when `state` was built for the
            // currently-selected asset. On a sibling switch this is false
            // for one frame (until the `.task` below refires), so we show
            // the neutral placeholder instead of the prior asset's edits.
            if let state, builtAssetID == session.asset.id {
                EditorView(
                    state: state,
                    onDismiss: onDismiss,
                    onShare: onShare,
                    onInfo: onInfo,
                    filmstripAssets: filmstripAssets,
                    onSelectAsset: onSelectAsset,
                    filmstripSource: filmstripSource
                )
            } else {
                Color.clear
            }
        }
        // Build / rebuild the EditorState when the active session changes.
        // The session already exists in AppShell.sessions, so this is a
        // synchronous identity check — no async session creation here.
        // `state` and `builtAssetID` are set together so the gate above
        // never sees a state that doesn't match the live session.
        .task(id: session.asset.id) {
            state = EditorState(session: session)
            builtAssetID = session.asset.id
        }
        .onDisappear {
            // S5 spec risk #4b — flush the debounced sidecar write before
            // tear-down so an undo-then-leave persists the right value.
            let session = self.session
            Task.detached { await session.flushPendingSidecarWrite() }
        }
    }
}
