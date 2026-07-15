// EditorDestination.swift — responsive-program S5 (#625).
//
// Push destination for the iPhone Library tab. Resolves (or creates)
// the per-asset `EditSession`, hands it to an `EditorState`, and renders
// the editor. On dismiss, flushes any pending XMP write so an
// undo-then-leave sequence persists the right value (spec §8 risk #4b).
//
// Lives in the app target so it can touch `EditSession` + `XMPSidecarStore`
// without expanding MapleCore's SwiftUI surface.

#if os(iOS)

import SwiftUI
import MapleCore

struct EditorDestination: View {
    let asset: AssetRef
    @Binding var sessions: [AssetRef.ID: EditSession]
    @Environment(\.dismiss) private var dismiss

    @State private var state: EditorState?

    /// Whether the Info inspector sheet is presented. On iPhone the S5
    /// editor is a full-screen NavigationStack push with no room for a
    /// persistent inspector column, so Info is a modal sheet. The header's
    /// `(i)` button toggles it (#875 item 2). `@State` persists across the
    /// editor's lifetime, so the show/hide choice survives re-renders.
    @State private var showInfo = false

    var body: some View {
        Group {
            if let state {
                EditorView(
                    state: state,
                    onDismiss: { dismiss() },
                    onShare: {},
                    onInfo: { showInfo.toggle() }
                )
                .sheet(isPresented: $showInfo) {
                    NavigationStack {
                        DetailPanel(session: state.session)
                            .navigationTitle("Info")
                            .navigationBarTitleDisplayMode(.inline)
                            .toolbar {
                                ToolbarItem(placement: .topBarTrailing) {
                                    Button("Done") { showInfo = false }
                                }
                            }
                    }
                    .presentationDetents([.medium, .large])
                }
            } else {
                Color.clear
            }
        }
        .stackBackSwipe { dismiss() }
        .task(id: asset.id) {
            // Build (or reuse) the EditSession + EditorState. `EditSession.init`
            // is synchronous — sidecar / as-shot WB load lazily on first render
            // via `loadSidecar()` / `ensureRenderStarted()`, NOT during init —
            // so this closure has no real await. (The stale comment + spurious
            // `await` here triggered Swift's "no async operations occur within
            // await" warning.)
            // Keep ONLY the active asset's session resident. Each EditSession
            // holds its GPU live buffers + decoded/developed cache — roughly one
            // large RAW's worth — and the `sessions` dict (AppShell @State) is
            // otherwise never pruned, so switching between two 100 MP images kept
            // both resident and jetsam-killed iOS at the ~6 GB limit (#1660).
            // Dropping the others here frees that memory BEFORE the new decode
            // runs. The RAW handle (RawImageCache, single-entry) is already
            // evicted on switch, so switching back re-decodes regardless.
            if let existing = sessions[asset.id] {
                if sessions.count > 1 { sessions = [asset.id: existing] }
                self.state = EditorState(session: existing)
                return
            }
            sessions = [:]
            let session = EditSession(asset: asset)
            sessions[asset.id] = session
            self.state = EditorState(session: session)
        }
        .onDisappear {
            // Per S5 spec risk #4b — flush pending XMP write before tear-down
            // so an undo-then-leave persists the right value, not the stale
            // pre-undo value sitting in the debounce window.
            if let session = state?.session {
                // #2009 — persist the developed `<filename>.avif` on exit
                // (GPU readback + any pending idle-debounce frame). Strong
                // `session` capture so the write lands even if the popped
                // destination's session is released right after.
                Task { await session.persistDisplayPreviewOnExit() }
                Task.detached { await session.flushPendingSidecarWrite() }
            }
        }
    }
}

#endif
