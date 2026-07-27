// PhoneSearchStub.swift — iPhone Search tab host (responsive-program S7).
//
// The file name is retained for git/Xcode-group continuity (a later PR
// renames it). `PhoneSearchTab` is the production view: it owns the
// account-wide `SearchViewModel`, its own NavigationStack, and the open
// route for tapped results. The search FIELD and the bottom nav are
// the native system tab bar — this tab lives inside a `Tab(role: .search)`
// in `PhoneTabShell` and carries the `.searchable` field whose text is bound
// here as `query`.
//
// Open presentation (#2371): a tapped result pushes `.preview` onto this
// tab's own `[LibraryDestination]` stack, exactly as `PhoneLibraryView`
// does for the Library tab — Preview first, and the editor only from
// Preview's Edit button (Fast Preview §1). Each destination hides the tab
// bar (and with it the search field) so it owns the whole screen.
//
// This replaced the search-only `HeroZoomEditorOverlay` presentation
// (#1489), which zoomed a tapped tile straight into the editor and so was
// the one surface in the app that skipped Preview.

#if os(iOS)

import SwiftUI
import MapleCore
import UIKit

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
    /// This tab's navigation stack. Empty → the result grid is the whole tab;
    /// `[.preview(a)]` → Preview; `[.preview(a), .edit(a)]` → the editor
    /// reached from Preview's Edit button. Same typed route the Library tab
    /// uses, so back pops `editor → Preview → grid`.
    @State private var path: [LibraryDestination] = []
    @FocusState private var searchFieldFocused: Bool

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle("Search")
                .navigationBarTitleDisplayMode(.inline)
                // Mirrors `PhoneLibraryView`'s resolution (Fast Preview §1):
                // `.preview` → the fast static surface, `.edit` → the editor.
                // Both hide the tab bar + system nav bar; each ships its own
                // 44pt header with a back button.
                .navigationDestination(for: LibraryDestination.self) { destination in
                    Group {
                        switch destination {
                        case .preview(let ref):
                            PreviewDestination(
                                asset: ref,
                                // A search result is a single-asset preview:
                                // the result set is this tab's own grid, not a
                                // folder listing, so there is no sibling list
                                // to hand the filmstrip. Same shape the Library
                                // tab uses for cloud / search taps.
                                assets: [ref],
                                source: nil,
                                sessions: $sessions,
                                onClose: popWithoutAnimation,
                                onEdit: { path.append(.edit($0)) },
                                // Prev/next can't move within a one-asset list,
                                // so there is no selection to propagate — the
                                // search grid owns its own selection state.
                                onSelectionChanged: { _ in }
                            )
                        case .edit(let ref):
                            EditorDestination(asset: ref, sessions: $sessions)
                        }
                    }
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
        // when nothing is pushed on top.
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
                    path.append(.preview(resolveAsset(asset, session.server)))
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

    /// Pop the top destination without the stack's own slide. `PreviewDestination`
    /// runs its own scale/fade close and calls back when it's finished, so a
    /// second animation here would play on top of one that has already ended.
    /// Same helper as `PhoneLibraryView.popPreviewWithoutAnimation`.
    private func popWithoutAnimation() {
        guard !path.isEmpty else { return }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        UIView.performWithoutAnimation {
            withTransaction(transaction) {
                _ = path.removeLast()
            }
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
