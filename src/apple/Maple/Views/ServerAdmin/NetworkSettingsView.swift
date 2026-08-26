// NetworkSettingsView.swift — Settings → Cloud → Manage → Network (#2766).
//
// Mirrors the web page at src/web/.../settings/network. The resolved
// section reports what the server actually decided and where each value
// came from; the override section is what the operator can change. The
// seeding rule that keeps those two honest lives in
// NetworkSettingsForm.seeded(from:) — an auto-detected address must never
// appear in an override field.

import SwiftUI
import MapleCore
import MapleUI

struct NetworkSettingsView: View {
    let client: NetworkConfigClient

    private enum LoadState: Equatable {
        case loading
        case loaded(NetworkConfig)
        case failed(String)
    }

    @State private var loadState: LoadState = .loading
    @State private var form = NetworkSettingsForm()
    @State private var saveState: ServerAdminActionState = .idle
    @State private var saveConfirmationTask: Task<Void, Never>?

    var body: some View {
        Form {
            switch loadState {
            case .loading:
                Section {
                    HStack {
                        Text("Loading configuration…").foregroundStyle(.secondary)
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                }
                .listRowBackground(MapleTokens.surface)
            case .failed(let message):
                Section {
                    Text("Failed to load config: \(message)")
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("network.loadError")
                    Button("Retry") { Task { await load() } }
                }
                .listRowBackground(MapleTokens.surface)
            case .loaded(let config):
                resolvedSection(config)
                overrideSection
            }
        }
        .formStyle(.grouped)
        .mapleSettingsBackground()
        .task { await load() }
        .onDisappear { saveConfirmationTask?.cancel() }
    }

    // MARK: - Sections

    @ViewBuilder
    private func resolvedSection(_ config: NetworkConfig) -> some View {
        Section("Current (resolved)") {
            LabeledContent("Advertising a LAN address") {
                Text(config.enabled ? "Yes" : "No")
                    .foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("network.resolved.enabled")

            LabeledContent("Address") {
                HStack(spacing: 4) {
                    Text(NetworkSettingsVM.addressDisplay(config))
                        .foregroundStyle(config.localIP == nil ? .secondary : .primary)
                    Text(NetworkSettingsVM.provenanceLabel(config.source.localIP))
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityIdentifier("network.resolved.address")

            LabeledContent("Port") {
                HStack(spacing: 4) {
                    Text("\(config.localPort)")
                    Text(NetworkSettingsVM.provenanceLabel(config.source.localPort))
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityIdentifier("network.resolved.port")

            if NetworkSettingsVM.shouldWarnNoLANAddress(config) {
                Text("""
                    No LAN address could be detected. This is expected when the \
                    server runs inside a container with a bridge network — set an \
                    override below so clients on the same network can connect \
                    directly.
                    """)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .accessibilityIdentifier("network.unavailableWarning")
            }
        }
        .listRowBackground(MapleTokens.surface)
    }

    @ViewBuilder
    private var overrideSection: some View {
        Section("Override") {
            TextField("LAN address", text: $form.ipOverride, prompt: Text("192.168.1.42"))
                .font(.system(.body, design: .monospaced))
                #if os(iOS)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                #endif
                .accessibilityIdentifier("network.ipOverride")

            TextField("Port", text: $form.portOverride, prompt: Text("3000"))
                .font(.system(.body, design: .monospaced))
                #if os(iOS)
                .keyboardType(.numberPad)
                #endif
                .accessibilityIdentifier("network.portOverride")

            Text("Blank uses the server's listen port.")
                .font(.caption)
                .foregroundStyle(.secondary)

            Toggle("Advertise a LAN address to clients", isOn: $form.enabled)
                .accessibilityIdentifier("network.enabled")

            serverAdminActionButton(
                "Save", variant: .primary, state: saveState, successText: "Saved.",
                identifier: "network.save",
                successIdentifier: "network.saved",
                failureIdentifier: "network.saveError",
                action: { Task { await save() } }
            )
        }
        .listRowBackground(MapleTokens.surface)
    }

    // MARK: - Actions

    private func load() async {
        loadState = .loading
        do {
            let config = try await client.fetch()
            // Seed once per load. In-progress edits are only discarded by
            // an explicit Retry, never by a background refresh.
            form = NetworkSettingsForm.seeded(from: config)
            loadState = .loaded(config)
        } catch {
            loadState = .failed(error.localizedDescription)
        }
    }

    private func save() async {
        let validation = form.validated()
        guard case .valid(let patch) = validation else {
            if case .invalid(let message) = validation { saveState = .failed(message) }
            return
        }
        saveState = .running
        do {
            let config = try await client.save(patch)
            // Re-seed from the server's answer rather than trusting the
            // local form: the server may have resolved a value the patch
            // only cleared.
            form = NetworkSettingsForm.seeded(from: config)
            loadState = .loaded(config)
            saveState = .succeeded
            saveConfirmationTask?.cancel()
            // Explicitly @MainActor for the same reason as the Cloudflare
            // page — this mutates SwiftUI @State and shouldn't depend on
            // isolation inheritance to be correct.
            saveConfirmationTask = Task { @MainActor in
                try? await Task.sleep(for: .seconds(2))
                if !Task.isCancelled, saveState == .succeeded { saveState = .idle }
            }
        } catch {
            saveState = .failed(error.localizedDescription)
        }
    }
}

#Preview("Unreachable server") {
    NetworkSettingsView(client: .preview())
        .frame(width: 560, height: 520)
}
