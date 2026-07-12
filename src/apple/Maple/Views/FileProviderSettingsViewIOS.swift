// src/apple/Maple/Views/FileProviderSettingsViewIOS.swift
#if os(iOS)
import SwiftUI
import MapleCore

struct FileProviderSettingsViewIOS: View {
    @State private var model = FileProviderSettingsModel()
    @State private var registry = CloudServerRegistry.shared

    var body: some View {
        // Bare Form (no NavigationStack) — this view is pushed inside the
        // Settings tab's own NavigationStack from PhoneSettingsView, and a
        // second nested NavigationStack there produces a duplicate nav bar
        // (the exact nested-chrome bug responsive-program S8 (#1903) fixed
        // for the Settings tab itself). The Mac/iPad `SettingsView` TabView
        // "Files" tab renders this bare too, matching its sibling tabs
        // (General/Backup/Cloud/Pano), none of which show an in-content
        // title either.
        Form {
            Section {
                if registry.servers.isEmpty {
                    Text("No Maple servers paired. Go to Settings → Cloud to add one.")
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
            .listRowBackground(MapleTokens.surface)

            if let msg = model.statusMessage {
                Section {
                    Text(msg)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("file-provider-status")
                }
                .listRowBackground(MapleTokens.surface)
            }
        }
        .formStyle(.grouped)
        .mapleSettingsBackground()
        .task { await model.reload() }
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
            if enabled {
                HStack(spacing: 12) {
                    Button("Refresh") { Task { await model.refresh(url) } }
                        .accessibilityIdentifier("file-provider-refresh-\(domainID ?? host)")
                    Button("Disable", role: .destructive) {
                        Task { await model.disable(url) }
                    }
                    .disabled(busy)
                    .accessibilityIdentifier("file-provider-disable-\(domainID ?? host)")
                }
                .buttonStyle(.bordered)
            } else {
                HStack(spacing: 12) {
                    Button("Enable in Files") {
                        Task { await model.enable(serverURL: url, displayName: displayName) }
                    }
                    .disabled(busy)
                    .accessibilityIdentifier("file-provider-enable-\(domainID ?? host)")
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Previews
//
// Issue #139 — iOS-only File Provider settings. Empty registry on a
// clean preview env exercises the "No Maple servers paired" branch.

#Preview("Default — no servers") {
    FileProviderSettingsViewIOS()
}
#endif
