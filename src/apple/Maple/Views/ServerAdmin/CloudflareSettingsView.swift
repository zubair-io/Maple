// CloudflareSettingsView.swift — Settings → Cloud → Manage → Cloudflare (#2767).
//
// Configures the R2 edge mirror for thumbnails. Mirrors the web page at
// src/web/.../settings/cloudflare, including the two static explanations:
// the JWT signing secret is deliberately exposed by no route, and backfill
// of existing thumbnails is the `cf-thumb-sync` pipeline stage rather than a
// button here.

import SwiftUI
import MapleCore
import MapleUI

struct CloudflareSettingsView: View {
    let client: CloudflareConfigClient

    private enum LoadState: Equatable {
        case loading
        case loaded(CloudflareConfig)
        case failed(String)
    }

    @State private var loadState: LoadState = .loading
    @State private var form = CloudflareSettingsForm()
    @State private var saveState: ServerAdminActionState = .idle
    @State private var testState: ServerAdminActionState = .idle
    @State private var saveConfirmationTask: Task<Void, Never>?

    private var secretIsSet: Bool {
        if case .loaded(let config) = loadState { return config.secretAccessKeySet }
        return false
    }

    var body: some View {
        Form {
            switch loadState {
            case .loading:
                Section {
                    HStack {
                        Text("Loading…").foregroundStyle(.secondary)
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                }
                .listRowBackground(MapleTokens.surface)
            case .failed(let message):
                Section {
                    MuiBanner(
                        variant: .error, message: "Failed to load config: \(message)",
                        actionLabel: "Retry", actionPressed: { Task { await load() } }
                    )
                    .accessibilityIdentifier("cloudflare.loadError")
                }
                .listRowBackground(MapleTokens.surface)
            case .loaded(let config):
                credentialsSection(config)
                actionsSection
                explanationSections
            }
        }
        .formStyle(.grouped)
        .mapleSettingsBackground()
        .task { await load() }
        .onDisappear { saveConfirmationTask?.cancel() }
    }

    // MARK: - Sections

    @ViewBuilder
    private func credentialsSection(_ config: CloudflareConfig) -> some View {
        Section("Cloudflare R2") {
            MuiToggle(checked: $form.enabled, label: "Upload thumbnails to Cloudflare")
                .accessibilityIdentifier("cloudflare.enabled")
            Text(CloudflareSettingsVM.statusSummary(config))
                .font(.caption)
                .foregroundStyle(.secondary)

            LabeledContent("Account ID") {
                MuiInput(
                    value: $form.accountID, accessibilityLabel: "Account ID",
                    placeholder: "a1b2c3d4e5f6…", monospaced: true, autocorrectionDisabled: true
                )
                .accessibilityIdentifier("cloudflare.accountID")
            }

            LabeledContent("Bucket name") {
                MuiInput(
                    value: $form.bucket, accessibilityLabel: "Bucket name",
                    placeholder: "maple-thumbs", monospaced: true, autocorrectionDisabled: true
                )
                .accessibilityIdentifier("cloudflare.bucket")
            }

            LabeledContent("Access key ID") {
                MuiInput(
                    value: $form.accessKeyID, accessibilityLabel: "Access key ID",
                    placeholder: "AKIAEXAMPLE…", monospaced: true, autocorrectionDisabled: true
                )
                .accessibilityIdentifier("cloudflare.accessKeyID")
            }

            LabeledContent("Secret access key") {
                MuiInput(
                    value: $form.secretAccessKey, accessibilityLabel: "Secret access key",
                    placeholder: CloudflareSettingsVM.secretPlaceholder(secretIsSet: secretIsSet),
                    secure: true, monospaced: true
                )
                .accessibilityIdentifier("cloudflare.secretAccessKey")
            }
            Text("Write-only — never sent back. Leave blank to keep the saved key.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .listRowBackground(MapleTokens.surface)
    }

    @ViewBuilder
    private var actionsSection: some View {
        Section {
            serverAdminActionButton(
                "Test", state: testState, successText: "Connected.",
                identifier: "cloudflare.test",
                disabledReason: CloudflareSettingsVM.testDisabledReason(form, secretIsSet: secretIsSet),
                disabled: !CloudflareSettingsVM.canTest(form),
                action: { Task { await test() } }
            )

            serverAdminActionButton(
                "Save", variant: .primary, state: saveState, successText: "Saved.",
                identifier: "cloudflare.save",
                action: { Task { await save() } }
            )
        }
        .listRowBackground(MapleTokens.surface)
    }

    @ViewBuilder
    private var explanationSections: some View {
        Section("Worker authentication") {
            Text("""
                The Worker's JWT signing secret is deliberately not shown here and is \
                exposed by no API route. Read it from MongoDB — collection \
                `server_state`, `_id: "jwt_secret"`, field `value` — and install it with \
                `wrangler secret put JWT_SECRET`.
                """)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .listRowBackground(MapleTokens.surface)

        Section("Syncing existing thumbnails") {
            Text("""
                Backfill runs as the `cf-thumb-sync` pipeline stage, not from this \
                screen. Watch its progress under Workers.
                """)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .listRowBackground(MapleTokens.surface)
    }

    // MARK: - Actions

    @MainActor
    private func load() async {
        loadState = .loading
        do {
            let config = try await client.fetch()
            form = CloudflareSettingsForm.seeded(from: config)
            loadState = .loaded(config)
        } catch {
            loadState = .failed(error.localizedDescription)
        }
    }

    @MainActor
    private func save() async {
        saveState = .running
        testState = .idle
        do {
            let config = try await client.save(form.patch())
            // Re-seed from the server's answer, which also clears the secret
            // field back to blank now that the key is stored.
            form = CloudflareSettingsForm.seeded(from: config)
            loadState = .loaded(config)
            saveState = .succeeded
            saveConfirmationTask?.cancel()
            // Explicitly @MainActor rather than relying on isolation
            // inheritance: this closure mutates SwiftUI @State, and the
            // codebase spells that out at its other Task sites
            // (SelfHostedSettingsTab, AppShell+CloudActions).
            saveConfirmationTask = Task { @MainActor in
                try? await Task.sleep(for: .seconds(2))
                if !Task.isCancelled, saveState == .succeeded { saveState = .idle }
            }
        } catch {
            // A 502 here means the server rejected the credentials against
            // R2 and saved nothing — surfacing it as a failure is load-bearing.
            saveState = .failed(error.localizedDescription)
        }
    }

    @MainActor
    private func test() async {
        guard let credentials = form.testCredentials() else { return }
        testState = .running
        do {
            try await client.test(credentials)
            testState = .succeeded
        } catch {
            testState = .failed(error.localizedDescription)
        }
    }
}

#Preview("Unreachable server") {
    CloudflareSettingsView(client: .preview())
        .frame(width: 620, height: 640)
}
