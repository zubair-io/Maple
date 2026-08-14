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
            List(sections) { section in
                NavigationLink {
                    page(for: section)
                        .navigationTitle(section.title)
                        .navigationBarTitleDisplayMode(.inline)
                } label: {
                    Label(section.title, systemImage: section.icon)
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
            ContentUnavailableView(
                "Owner access required",
                systemImage: "lock",
                description: Text(
                    "Server administration is available to the account that owns this server."))
        } else {
            ContentUnavailableView("Select a section", systemImage: "sidebar.left")
        }
    }

    @ViewBuilder
    private func page(for section: ServerAdminSection) -> some View {
        switch section {
        case .network:
            NetworkSettingsView(
                client: NetworkConfigClient(
                    server: server,
                    httpClient: makeCloudHTTPClient(server: server, session: session)))
        }
    }
}
