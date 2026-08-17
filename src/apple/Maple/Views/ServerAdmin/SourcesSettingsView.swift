// SourcesSettingsView.swift — Settings → Cloud → Manage → Sources (#2898).
//
// Mirrors the web page at src/web/.../settings/sources: every library root
// registered with the server, with its live connection status. This is the
// recovery surface for the sidebar's hiding rule — a disconnected source
// (unmounted share, unplugged drive) disappears from the sidebar tree, so
// this page is where the operator sees it still exists, learns why it's
// hidden, and re-checks after re-mounting. "Check again" passes `fresh=1`
// so the server bypasses its 30s connectivity cache.

import SwiftUI
import MapleCore

struct SourcesSettingsView: View {
    let client: CloudFoldersClient

    private enum LoadState: Equatable {
        case loading
        case loaded([CloudFolder])
        case failed(String)
    }

    @State private var loadState: LoadState = .loading
    @State private var isChecking = false

    var body: some View {
        Form {
            switch loadState {
            case .loading:
                Section {
                    HStack {
                        Text("Loading sources…").foregroundStyle(.secondary)
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                }
                .listRowBackground(MapleTokens.surface)
            case .failed(let message):
                Section {
                    Text("Failed to load sources: \(message)")
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("sources.loadError")
                    Button("Retry") { Task { await load(fresh: false) } }
                }
                .listRowBackground(MapleTokens.surface)
            case .loaded(let folders):
                foldersSection(folders)
                checkAgainSection
            }
        }
        .formStyle(.grouped)
        .mapleSettingsBackground()
        .task { await load(fresh: false) }
    }

    // MARK: - Sections

    @ViewBuilder
    private func foldersSection(_ folders: [CloudFolder]) -> some View {
        let disconnected = folders.filter { !$0.isConnected }.count
        Section {
            if folders.isEmpty {
                Text("No sources registered on this server yet.")
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("sources.empty")
            }
            ForEach(folders) { folder in
                row(folder)
            }
        } header: {
            Text("Sources")
        } footer: {
            if disconnected > 0 {
                Text("\(disconnected) source\(disconnected == 1 ? " is" : "s are") currently unreachable and hidden from the sidebar. Nothing was removed — files and edits reappear when the source is reachable again.")
                    .accessibilityIdentifier("sources.disconnectedHint")
            }
        }
        .listRowBackground(MapleTokens.surface)
    }

    private func row(_ folder: CloudFolder) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Circle()
                .fill(folder.isConnected ? Color.green : Color.orange)
                .frame(width: 8, height: 8)
                .accessibilityLabel(folder.isConnected ? "Connected" : "Not connected")
            VStack(alignment: .leading, spacing: 2) {
                Text(folder.displayName)
                Text(folder.path)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(folder.isConnected ? "Connected" : "Not connected")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(folder.isConnected ? .secondary : Color.orange)
                Text("\(folder.file_count) files")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .opacity(folder.isConnected ? 1 : 0.75)
        .accessibilityIdentifier("sources.row.\(folder.id)")
    }

    private var checkAgainSection: some View {
        Section {
            Button {
                Task { await load(fresh: true) }
            } label: {
                HStack {
                    Text(isChecking ? "Checking…" : "Check again")
                    if isChecking {
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                }
            }
            .disabled(isChecking)
            .accessibilityIdentifier("sources.checkAgain")
        } footer: {
            Text("Re-probes every source, bypassing the server's short connectivity cache.")
        }
        .listRowBackground(MapleTokens.surface)
    }

    // MARK: - Load

    private func load(fresh: Bool) async {
        if fresh {
            isChecking = true
        } else {
            loadState = .loading
        }
        defer { isChecking = false }
        do {
            let folders = try await client.listFolders(fresh: fresh)
            loadState = .loaded(folders)
        } catch {
            // A failed fresh re-check keeps the last-known list on screen
            // only if we already had one; a failed initial load reports.
            if case .loaded = loadState, fresh { return }
            loadState = .failed(error.localizedDescription)
        }
    }
}
