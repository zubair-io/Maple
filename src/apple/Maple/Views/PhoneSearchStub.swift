// PhoneSearchStub.swift — iPhone Search tab host (responsive-program S7).
//
// The file name is retained for git/Xcode-group continuity (a later PR
// renames it). `PhoneSearchTab` is the production view: it owns the
// account-wide `SearchViewModel`, its own NavigationStack, and the editor
// presentation for tapped results. The search FIELD and the bottom nav are
// the native system tab bar — this tab lives inside a `Tab(role: .search)`
// in `PhoneTabShell` and carries the `.searchable` field whose text is bound
// here as `query`.
//
// Editor presentation (#1489): a tapped result does NOT push onto this
// tab's `NavigationStack` — it presents `HeroZoomEditorOverlay` in a
// `ZStack` above the tab's content, so the thumbnail zooms open into the
// editor and zooms back on close. The overlay owns both gestures outright,
// which a push could not: the only way to get a zoom out of a push is
// `.navigationTransition(.zoom(sourceID:in:))`, whose non-disableable
// pinch-to-dismiss beats `CanvasZoomHost`'s pinch and closes the editor
// while the user is zooming in. The tab bar (and with it the search field)
// is hidden for the duration so the overlay is the whole screen.

#if os(iOS)

import SwiftUI
import MapleCore

struct PhoneSearchTab: View {
    @Binding var sessions: [AssetRef.ID: EditSession]
    /// Live query text, bound to the host's `.searchable` search field.
    @Binding var query: String
    /// Stable id for the resolved cloud account; nil → no account → empty state.
    let serverKey: String?
    /// Builds the account-wide search session for the resolved server.
    let makeSession: () async -> PhoneSearchSession?
    /// Resolve a tapped result into an editor-ready AssetRef (populates
    /// `sessions` with a CloudSidecarStore-backed EditSession).
    let resolveAsset: (SearchAsset, URL) -> AssetRef

    @State private var session: PhoneSearchSession?
    @State private var didLoad = false
    /// The result currently open in the hero-zoomed editor, plus the tile it
    /// was opened from. `nil` → no editor, the grid is the whole tab.
    @State private var openResult: OpenResult?
    @FocusState private var searchFieldFocused: Bool

    /// A result open in the editor: the resolved asset and the grid tile the
    /// zoom flies out of (and back into).
    private struct OpenResult: Identifiable {
        let asset: AssetRef
        let hero: PhotoGridHeroSource?
        var id: AssetRef.ID { asset.id }
    }

    var body: some View {
        ZStack {
            NavigationStack {
                content
                    .navigationTitle("Search")
                    .navigationBarTitleDisplayMode(.inline)
            }

            if let open = openResult {
                HeroZoomEditorOverlay(
                    asset: open.asset,
                    source: open.hero,
                    sessions: $sessions,
                    onClosed: { openResult = nil }
                )
                // Identity per asset so opening a second result after the
                // first has closed builds a fresh overlay (and a fresh
                // animation) rather than reusing the collapsed one.
                .id(open.id)
            }
        }
        // The native search field for the `Tab(role: .search)` this view
        // lives in — its text drives the same `query` the content reads.
        .searchable(text: $query, prompt: "Search your library")
        .searchFocused($searchFieldFocused)
        // The overlay is the whole screen while it's up, so the system tab
        // bar (which carries the search field) gets out of its way — the same
        // contract a pushed destination gets from `.toolbar(.hidden, for:)`.
        .toolbar(openResult == nil ? .visible : .hidden, for: .tabBar)
        // Focus the search field the moment the Search tab is entered (Apple
        // Photos drops you straight into typing). Deferred one runloop so the
        // searchable field is in the hierarchy before focus moves to it; only
        // when the editor isn't open on top.
        .onAppear {
            if openResult == nil {
                Task { @MainActor in searchFieldFocused = true }
            }
        }
        // Build the account-wide session once per resolved account. Guard on
        // the existing session's own server so a tab re-appearance KEEPS the
        // current view model — and its results — instead of rebuilding an
        // empty one. Rebuild only when the account changes, or none exists yet.
        .task(id: serverKey) {
            guard let key = serverKey else {
                session = nil
                didLoad = true
                return
            }
            // Same account as the current session — keep it (and its results).
            if session?.server.absoluteString == key {
                didLoad = true
                return
            }
            // Account changed: clear the stale session so the loading state
            // shows (not the previous account's results) while the new one
            // builds.
            session = nil
            didLoad = false
            let newSession = await makeSession()
            // `.task(id:)` cancels this when serverKey changes again; don't let
            // a superseded build overwrite a newer session.
            guard !Task.isCancelled else { return }
            session = newSession
            didLoad = true
        }
    }

    @ViewBuilder
    private var content: some View {
        if let session {
            SearchView(
                viewModel: session.vm,
                thumbClient: session.thumbClient,
                thumbCache: session.thumbCache,
                query: $query,
                onSelectAsset: { asset, hero in
                    openResult = OpenResult(
                        asset: resolveAsset(asset, session.server),
                        hero: hero
                    )
                }
            )
        } else if !didLoad {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(MapleTokens.bg.ignoresSafeArea())
        } else {
            PhoneSearchEmptyState()
        }
    }
}

/// Shown when no Maple Cloud account is connected/signed-in.
private struct PhoneSearchEmptyState: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 40))
                .foregroundStyle(MapleTokens.textMuted)
            Text("Search your cloud account")
                .font(MapleTokens.Typography.sheetTitle)
                .foregroundStyle(MapleTokens.textMain)
            Text("Connect a Maple Cloud account to search your photos by place, person, camera, and more.")
                .font(MapleTokens.Typography.rowLabel)
                .foregroundStyle(MapleTokens.textMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MapleTokens.bg.ignoresSafeArea())
        .accessibilityIdentifier("search-empty-no-account")
    }
}

#endif
