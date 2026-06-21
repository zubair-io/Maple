// PhoneSearchStub.swift — iPhone Search tab host (responsive-program S7).
//
// The file name is retained for git/Xcode-group continuity (a later PR
// renames it). `PhoneSearchTab` is the production view: it owns the
// account-wide `SearchViewModel` (built by AppShell's factory), its own
// NavigationStack, and the editor push for tapped results.

#if os(iOS)

import SwiftUI
import MapleCore

struct PhoneSearchTab: View {
    @Binding var sessions: [AssetRef.ID: EditSession]
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
        // Rebuild whenever the resolved account changes (open a cloud library,
        // sign in). serverKey == nil short-circuits to the empty state with no
        // network attempt.
        .task(id: serverKey) {
            didLoad = false
            session = serverKey == nil ? nil : await makeSession()
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
