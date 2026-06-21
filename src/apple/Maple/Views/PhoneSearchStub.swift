// PhoneSearchStub.swift — iPhone Search tab host (responsive-program S7).
//
// The file name is retained for git/Xcode-group continuity (a later PR
// renames it). `PhoneSearchTab` is the production view: it owns the
// account-wide `SearchViewModel`, its own NavigationStack, and the editor
// push for tapped results. The search FIELD and the bottom nav are the
// native system tab bar — this tab lives inside a `Tab(role: .search)` in
// `PhoneTabShell` and carries the `.searchable` field whose text is bound
// here as `query`.

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
    @State private var path: [AssetRef] = []
    @State private var didLoad = false
    @FocusState private var searchFieldFocused: Bool

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle("Search")
                .navigationBarTitleDisplayMode(.inline)
                .navigationDestination(for: AssetRef.self) { ref in
                    EditorDestination(asset: ref, sessions: $sessions)
                        .toolbar(.hidden, for: .tabBar)
                        .toolbar(.hidden, for: .navigationBar)
                }
        }
        // The native search field for the `Tab(role: .search)` this view
        // lives in — its text drives the same `query` the content reads.
        .searchable(text: $query, prompt: "Search your library")
        .searchFocused($searchFieldFocused)
        // Focus the search field the moment the Search tab is entered (Apple
        // Photos drops you straight into typing). Deferred one runloop so the
        // searchable field is in the hierarchy before focus moves to it; only
        // when the editor isn't pushed on top (path empty).
        .onAppear {
            if path.isEmpty {
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
                onSelectAsset: { asset in
                    path.append(resolveAsset(asset, session.server))
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
