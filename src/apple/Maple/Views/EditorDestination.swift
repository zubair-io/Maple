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
    /// Zoom-to-open wiring (#1489). Set only by `HeroZoomEditorOverlay`;
    /// `nil` on the pushed path, which behaves exactly as before.
    var heroZoom: EditorHeroZoom? = nil
    /// Overrides the NavigationStack pop when this destination is presented
    /// as an overlay instead of pushed — the hero presentation has to run
    /// its close animation before it is torn down, which `dismiss()` would
    /// skip straight past.
    var onClose: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss

    /// Leave — the hero close when we're an overlay, the stack pop otherwise.
    private var closeAction: () -> Void { onClose ?? { dismiss() } }

    @State private var state: EditorState?

    /// Whether the Info inspector sheet is presented. On iPhone the S5
    /// editor is a full-screen NavigationStack push with no room for a
    /// persistent inspector column, so Info is a modal sheet. The header's
    /// `(i)` button toggles it (#875 item 2). `@State` persists across the
    /// editor's lifetime, so the show/hide choice survives re-renders.
    @State private var showInfo = false

    // The Info sheet renders `DetailPanel` → `InfoPanelView` across a
    // `.sheet` boundary, which does NOT inherit custom `EnvironmentKey`
    // values from the presenter — so the enrichment (#2212) and histogram
    // (#633) cloud clients arrive `nil` inside the sheet and the
    // description / OCR / transcript section stays blank. Read them here
    // and re-inject onto the sheet content below.
    @Environment(\.cloudAssetDetailClient) private var detailClient
    @Environment(\.cloudHistogramClient) private var histogramClient

    var body: some View {
        Group {
            if let state {
                EditorView(
                    state: state,
                    onDismiss: closeAction,
                    onShare: {},
                    onInfo: { showInfo.toggle() },
                    heroZoom: heroZoom
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
                    .environment(\.cloudAssetDetailClient, detailClient)
                    .environment(\.cloudHistogramClient, histogramClient)
                    .presentationDetents([.medium, .large])
                }
            } else {
                Color.clear
            }
        }
        .stackBackSwipe(onBack: closeAction)
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
