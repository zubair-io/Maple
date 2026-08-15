// CloudflareSettingsView.swift — Settings → Cloud → Manage → Cloudflare (#2767).
//
// Configures the R2 edge mirror for thumbnails. Mirrors the web page at
// src/web/.../settings/cloudflare, including the two static explanations:
// the JWT signing secret is deliberately exposed by no route, and backfill
// of existing thumbnails is the `cf-thumb-sync` pipeline stage rather than a
// button here.

import SwiftUI
import MapleCore

struct CloudflareSettingsView: View {
    let client: CloudflareConfigClient

    private enum LoadState: Equatable {
        case loading
        case loaded(CloudflareConfig)
        case failed(String)
    }

    private enum ActionState: Equatable {
        case idle
        case running
        case succeeded
        case failed(String)
    }

    @State private var loadState: LoadState = .loading
    @State private var form = CloudflareSettingsForm()
    @State private var saveState: ActionState = .idle
    @State private var testState: ActionState = .idle
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
                    Text("Failed to load config: \(message)")
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("cloudflare.loadError")
                    Button("Retry") { Task { await load() } }
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
            Toggle("Upload thumbnails to Cloudflare", isOn: $form.enabled)
                .accessibilityIdentifier("cloudflare.enabled")
            Text(CloudflareSettingsVM.statusSummary(config))
                .font(.caption)
                .foregroundStyle(.secondary)

            LabeledContent("Account ID") {
                TextField("", text: $form.accountID, prompt: Text("a1b2c3d4e5f6…"))
                    .font(.system(.body, design: .monospaced))
                    #if os(iOS)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    #endif
                    .accessibilityIdentifier("cloudflare.accountID")
            }

            LabeledContent("Bucket name") {
                TextField("", text: $form.bucket, prompt: Text("maple-thumbs"))
                    .font(.system(.body, design: .monospaced))
                    #if os(iOS)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    #endif
                    .accessibilityIdentifier("cloudflare.bucket")
            }

            LabeledContent("Access key ID") {
                TextField("", text: $form.accessKeyID, prompt: Text("AKIAEXAMPLE…"))
                    .font(.system(.body, design: .monospaced))
                    #if os(iOS)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    #endif
                    .accessibilityIdentifier("cloudflare.accessKeyID")
            }

            LabeledContent("Secret access key") {
                SecureField(
                    "",
                    text: $form.secretAccessKey,
                    prompt: Text(CloudflareSettingsVM.secretPlaceholder(secretIsSet: secretIsSet)))
                    .font(.system(.body, design: .monospaced))
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
            Button {
                Task { await test() }
            } label: {
                HStack {
                    Text(testState == .running ? "Testing…" : "Test")
                    if testState == .running {
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                }
            }
            .disabled(!CloudflareSettingsVM.canTest(form) || testState == .running)
            .accessibilityIdentifier("cloudflare.test")

            if let reason = CloudflareSettingsVM.testDisabledReason(form, secretIsSet: secretIsSet) {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("cloudflare.testDisabledReason")
            }
            stateLabel(testState, successText: "Connected.", identifier: "cloudflare.testResult")

            Button {
                Task { await save() }
            } label: {
                HStack {
                    Text(saveState == .running ? "Saving…" : "Save")
                    if saveState == .running {
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                }
            }
            .disabled(saveState == .running)
            .accessibilityIdentifier("cloudflare.save")

            stateLabel(saveState, successText: "Saved.", identifier: "cloudflare.saveResult")
        }
        .listRowBackground(MapleTokens.surface)
    }

    @ViewBuilder
    private func stateLabel(
        _ state: ActionState, successText: String, identifier: String
    ) -> some View {
        switch state {
        case .failed(let message):
            Label(message, systemImage: "xmark.circle")
                .font(.caption)
                .foregroundStyle(.red)
                .accessibilityIdentifier("\(identifier).error")
        case .succeeded:
            Label(successText, systemImage: "checkmark.circle")
                .font(.caption)
                .foregroundStyle(.green)
                .accessibilityIdentifier("\(identifier).success")
        case .idle, .running:
            EmptyView()
        }
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
            saveConfirmationTask = Task {
                try? await Task.sleep(for: .seconds(2))
                if !Task.isCancelled, saveState == .succeeded { saveState = .idle }
            }
        } catch {
            // A 502 here means the server rejected the credentials against
            // R2 and saved nothing — surfacing it as a failure is load-bearing.
            saveState = .failed(error.localizedDescription)
        }
    }

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
