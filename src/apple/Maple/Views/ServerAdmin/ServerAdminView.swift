// ServerAdminView.swift — per-server administration surface (#2766).
//
// Hosted as a resizable window on macOS and a sheet on iOS; see
// ServerAdminSection for what appears in the sidebar. The macOS Settings
// window is a fixed 540×480 (MapleApp.swift), which is why this does not
// live inside it — the Workers table arriving in #2768 is eight columns
// wide.

import SwiftUI
import MapleCore

struct ServerAdminView: View {
    let server: URL
    let session: AuthSession

    @State private var selection: ServerAdminSection?
    @State private var registry = CloudServerRegistry.shared

    /// One authenticated client per server, built once and shared by every
    /// admin page.
    ///
    /// This must NOT be constructed inside a ViewBuilder. `AuthenticatedHTTPClient`
    /// coalesces 401 refreshes single-flight *per instance*, so a fresh instance
    /// per body evaluation would let two concurrent requests each refresh, rotate
    /// the refresh token twice, and trip the server's reuse detection — which
    /// revokes the whole token family and signs the user out. It also takes a
    /// `beginBackgroundTask` assertion per refresh via `BackgroundExecution`.
    @State private var httpClient: AuthenticatedHTTPClient?

    /// One events socket per server, for the same reason as `httpClient`
    /// but more acutely: this one owns a live WebSocket and a reconnect
    /// loop, so rebuilding it per body evaluation would tear down and
    /// re-handshake the connection on every state change.
    @State private var eventsClient: WorkerEventsClient?

    private var sections: [ServerAdminSection] {
        ServerAdminSection.visible(isOwner: session.isOwner)
    }

    private var serverName: String {
        registry.displayName(for: server) ?? server.host ?? server.absoluteString
    }

    var body: some View {
        content
            .task {
                if selection == nil { selection = sections.first }
                if httpClient == nil {
                    httpClient = makeCloudHTTPClient(server: server, session: session)
                }
                if eventsClient == nil {
                    let target = server
                    eventsClient = WorkerEventsClient(server: target) {
                        // Read the token per connection attempt rather than
                        // capturing one: a reconnect after a long drop must
                        // use whatever the refresh path has since rotated in.
                        guard let access = try TokenStore.load(server: target)?.access else {
                            throw ServerAdminError(
                                statusCode: 401, message: "not signed in to this server")
                        }
                        return access
                    }
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        #if os(macOS)
        NavigationSplitView {
            List(sections, selection: $selection) { section in
                Label(section.title, systemImage: section.icon)
                    .tag(section)
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 260)
            .navigationTitle(serverName)
        } detail: {
            detail
        }
        #else
        NavigationStack {
            Group {
                if sections.isEmpty {
                    // Without this a non-owner gets a blank List and the
                    // Manage… entry point looks broken. macOS states this
                    // via `detail`; iOS has no detail column, so it needs
                    // its own copy of the empty state.
                    ownerRequired
                } else {
                    List(sections) { section in
                        NavigationLink {
                            page(for: section)
                                .navigationTitle(section.title)
                                .navigationBarTitleDisplayMode(.inline)
                        } label: {
                            Label(section.title, systemImage: section.icon)
                        }
                    }
                }
            }
            .navigationTitle(serverName)
            .navigationBarTitleDisplayMode(.inline)
        }
        #endif
    }

    @ViewBuilder
    private var detail: some View {
        if let selection {
            page(for: selection)
        } else if sections.isEmpty {
            ownerRequired
        } else {
            ContentUnavailableView("Select a section", systemImage: "sidebar.left")
        }
    }

    /// Shown when the signed-in account owns no visible sections. Shared by
    /// the macOS detail column and the iOS stack so the two platforms can't
    /// drift into one explaining itself and the other going blank.
    private var ownerRequired: some View {
        ContentUnavailableView(
            "Owner access required",
            systemImage: "lock",
            description: Text(
                "Server administration is available to the account that owns this server."))
    }

    @ViewBuilder
    private func page(for section: ServerAdminSection) -> some View {
        if let httpClient, let eventsClient {
            switch section {
            case .network:
                // These per-page clients are stateless wrappers, so
                // rebuilding them per evaluation is free — the shared
                // `httpClient` above is the part that must not churn.
                NetworkSettingsView(
                    client: NetworkConfigClient(server: server, httpClient: httpClient))
            case .cloudflare:
                CloudflareSettingsView(
                    client: CloudflareConfigClient(server: server, httpClient: httpClient))
            case .enrichment:
                EnrichmentSettingsView(
                    client: EnrichmentConfigClient(server: server, httpClient: httpClient))
            case .workers:
                WorkersSettingsView(
                    client: WorkersAdminClient(server: server, httpClient: httpClient),
                    events: eventsClient)
            case .imports:
                ImportsSettingsView(
                    client: ImportsClient(server: server, httpClient: httpClient))
            }
        } else {
            // One `.task` tick, before the client exists.
            ProgressView().controlSize(.small)
        }
    }
}
