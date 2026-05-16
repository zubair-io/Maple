// src/apple/Maple/Views/FileProviderSettingsViewIOS.swift
#if os(iOS)
import SwiftUI
import MapleCore

struct FileProviderSettingsViewIOS: View {
    @State private var model = FileProviderSettingsModel()
    @State private var registry = CloudServerRegistry.shared

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if registry.servers.isEmpty {
                        Text("No Maple servers paired. Add one from the Self Hosted tab.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("file-provider-no-servers")
                    } else {
                        ForEach(registry.servers, id: \.absoluteString) { url in
                            serverRow(url: url)
                        }
                    }
                } header: {
                    Text("Maple servers")
                } footer: {
                    Text("Enabling a server mounts its photo library under Locations in the Files app. Originals stay on the server; files download on first tap.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let msg = model.statusMessage {
                    Section {
                        Text(msg)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("file-provider-status")
                    }
                }
            }
            .navigationTitle("Files")
            .task { await model.reload() }
        }
    }

    @ViewBuilder
    private func serverRow(url: URL) -> some View {
        let host = url.host ?? url.absoluteString
        let displayName = registry.displayName(for: url) ?? host
        let enabled = model.isEnabled(url)
        let domainID = FileProviderDomainController.domainIdentifier(for: url)
        let busy = domainID.map { model.inFlightDomains.contains($0) } ?? false

        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(displayName)
                    Text(host)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if enabled {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                }
            }
            HStack(spacing: 12) {
                if enabled {
                    Button("Refresh") { Task { await model.refresh(url) } }
                        .accessibilityIdentifier("file-provider-refresh-\(domainID ?? host)")
                    Button("Disable", role: .destructive) {
                        Task { await model.disable(url) }
                    }
                    .disabled(busy)
                    .accessibilityIdentifier("file-provider-disable-\(domainID ?? host)")
                } else {
                    Button("Enable in Files") {
                        Task { await model.enable(serverURL: url, displayName: displayName) }
                    }
                    .disabled(busy)
                    .accessibilityIdentifier("file-provider-enable-\(domainID ?? host)")
                }
            }
            .buttonStyle(.bordered)
        }
        .padding(.vertical, 4)
    }
}
#endif
