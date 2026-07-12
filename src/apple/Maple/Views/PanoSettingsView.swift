// PanoSettingsView.swift — Settings → Pano tab.
//
// Lets the user configure the two paths the panorama pipeline needs:
//   • Models directory — folder containing aliked.onnx + lightglue.onnx.
//   • ONNX Runtime dylib — path to libonnxruntime.dylib (≥ 1.23).
//
// Mirrors the BackupSettingsView pattern:
//   • UserDefaults persistence via PanoProvisioningDefaults keys.
//   • Debounced save on every edit (800ms, same cadence as Backup).
//   • Status indicator (provisioned / not provisioned) driven by
//     PanoProvisioning.status() checked on appear and on each change.
//
// Resolution order (shown in the footer so the user understands the
// precedence — mirrors the web's /settings/pano page):
//   1. These settings (UserDefaults).
//   2. MAPLE_PANO_MODELS / ORT_DYLIB_PATH environment variables (dev).
//   3. ~/Library/Application Support/app.justmaple.aperture/pano-models/
//      and …/ort/libonnxruntime.dylib (default locations).
//
// Auto-provisioning (#1234 M6): the "Download & Install" action runs
//   `PanoProvisioner`, which downloads + SHA-verifies the ONNX models (and,
//   on macOS, the ONNX Runtime dylib) into the default Application Support
//   location — so users don't have to configure paths manually. The path
//   fields remain as optional overrides for advanced setups.
//
// Ticket: #1241 / #1234 M6

import SwiftUI
import MapleCore
import OSLog

private let panoSettingsLog = Logger(
    subsystem: "app.justmaple.aperture",
    category: "Pano.SettingsView"
)

// MARK: - PanoSettingsView

struct PanoSettingsView: View {
    @State private var modelsDir: String = UserDefaults.standard.string(
        forKey: PanoProvisioningDefaults.modelsDirKey) ?? ""
    @State private var ortDylibPath: String = UserDefaults.standard.string(
        forKey: PanoProvisioningDefaults.ortDylibPathKey) ?? ""
    @State private var status: PanoProvisioningStatus = PanoProvisioning().status()
    @State private var saveDebounceTask: Task<Void, Never>?
    @State private var provisionModel = PanoProvisionModel()

    private let provisioning = PanoProvisioning()

    var body: some View {
        Form {
            statusSection
            pathsSection
            resolutionOrderSection
        }
        .formStyle(.grouped)
        .mapleSettingsBackground()
        .onChange(of: modelsDir) { _, _ in scheduleSave() }
        .onChange(of: ortDylibPath) { _, _ in scheduleSave() }
        .task { refreshStatus() }
    }

    // MARK: - Status section

    @ViewBuilder
    private var statusSection: some View {
        Section {
            HStack(spacing: 10) {
                Image(systemName: PanoProvisioner.isReady(status)
                      ? "checkmark.circle.fill"
                      : "exclamationmark.triangle.fill")
                    .foregroundStyle(PanoProvisioner.isReady(status) ? Color.green : Color.orange)
                    .imageScale(.medium)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(PanoProvisioner.isReady(status) ? "Ready" : "Not configured")
                        .font(.subheadline.weight(.medium))
                        .accessibilityLabel(PanoProvisioner.isReady(status)
                            ? "Panorama models and runtime are configured and ready"
                            : "Panorama models or runtime are not configured")
                    Text(statusDescription)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .combine)

            provisionActionView
        } header: {
            Text("Status")
        }
        .listRowBackground(MapleTokens.surface)
    }

    // MARK: - Auto-provision action

    @ViewBuilder
    private var provisionActionView: some View {
        switch provisionModel.state {
        case .idle:
            if !PanoProvisioner.isReady(status) {
                if PanoProvisioner.canAutoProvision(status) {
                    VStack(alignment: .leading, spacing: 6) {
                        Button {
                            startDownload()
                        } label: {
                            Label("Download & Install", systemImage: "arrow.down.circle")
                        }
                        .accessibilityIdentifier("pano.settings.download")
                        Text("Downloads \(downloadSummary) (~\(approxDownloadMB) MB) and installs "
                             + "them into the default Application Support location automatically.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)
                } else {
                    Text("A custom path is set below. Clear the override(s) to enable automatic setup.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 2)
                }
            }
        case let .running(fraction, label):
            VStack(alignment: .leading, spacing: 6) {
                ProgressView(value: fraction) {
                    Text(label).font(.caption)
                }
                Text("\(Int((fraction * 100).rounded()))%")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Installing panorama components, \(Int((fraction * 100).rounded())) percent")
        case let .failed(message):
            VStack(alignment: .leading, spacing: 6) {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    startDownload()
                } label: {
                    Label("Retry", systemImage: "arrow.clockwise")
                }
                .accessibilityIdentifier("pano.settings.retry")
            }
            .padding(.vertical, 2)
        }
    }

    private var downloadSummary: String {
        #if os(macOS)
        return "the ALIKED + LightGlue models and the ONNX Runtime"
        #else
        return "the ALIKED + LightGlue models"
        #endif
    }

    private var approxDownloadMB: Int {
        Int((Double(PanoProvisioner.approximateDownloadBytes) / 1_000_000).rounded())
    }

    private func startDownload() {
        Task {
            await provisionModel.download {
                refreshStatus()
            }
        }
    }

    private var statusDescription: String {
        if PanoProvisioner.isReady(status) {
            return "Panorama stitching is ready to use."
        }
        var missing: [String] = []
        if !status.modelsDirExists { missing.append("models") }
        #if os(macOS)
        // iOS embeds the ONNX Runtime at build time — never "missing" there.
        if !status.ortDylibExists { missing.append("ONNX Runtime") }
        #endif
        return "Missing: " + missing.joined(separator: ", ") + "."
    }

    // MARK: - Paths section

    @ViewBuilder
    private var pathsSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Models Directory")
                        .font(.callout)
                    Spacer()
                    sourceTag(for: status.modelsDirSource, exists: status.modelsDirExists)
                }
                TextField(
                    "e.g. ~/.cache/maple-pano/models",
                    text: $modelsDir
                )
                .font(.system(.callout, design: .monospaced))
                .textFieldStyle(.plain)
                .accessibilityLabel("Panorama models directory path")
                .accessibilityIdentifier("pano.settings.modelsDir")
                Text("Directory containing aliked.onnx and lightglue.onnx. " +
                     "Leave blank to use the MAPLE_PANO_MODELS environment variable or " +
                     "the default Application Support location.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 2)

            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("ONNX Runtime Dylib Path")
                        .font(.callout)
                    Spacer()
                    sourceTag(for: status.ortDylibSource, exists: status.ortDylibExists)
                }
                TextField(
                    "e.g. ~/.cache/maple-pano/libonnxruntime.dylib",
                    text: $ortDylibPath
                )
                .font(.system(.callout, design: .monospaced))
                .textFieldStyle(.plain)
                .accessibilityLabel("ONNX Runtime dylib path")
                .accessibilityIdentifier("pano.settings.ortDylibPath")
                Text("Path to libonnxruntime.dylib version ≥ 1.23. " +
                     "Leave blank to use the ORT_DYLIB_PATH environment variable or " +
                     "the default Application Support location.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 2)

        } header: {
            Text("Paths")
        } footer: {
            Text("These paths are optional overrides for advanced setups. Most users can leave "
                 + "them blank and use “Download & Install” above, which fetches the required "
                 + "files and installs them into the default Application Support location.")
                .font(.caption2)
                .foregroundStyle(Color(white: 0.5))
        }
        .listRowBackground(MapleTokens.surface)
    }

    // MARK: - Resolution order section

    @ViewBuilder
    private var resolutionOrderSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text("Priority order:")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                Text("1 — Settings (these fields)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("2 — MAPLE_PANO_MODELS / ORT_DYLIB_PATH environment variables")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("3 — ~/Library/Application Support/app.justmaple.aperture/pano-models/ and …/ort/")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
        } header: {
            Text("Resolution Order")
        }
        .listRowBackground(MapleTokens.surface)
    }

    // MARK: - Source tag helper

    private func sourceTagLabel(for source: PanoProvisioningStatus.Source) -> String {
        switch source {
        case .settings:   return "settings"
        case .environment: return "env"
        case .appSupport:  return "default"
        case .notSet:      return "not set"
        }
    }

    private func sourceTagColor(
        for source: PanoProvisioningStatus.Source,
        exists: Bool
    ) -> Color {
        switch source {
        case .settings:   return exists ? .green : .orange
        case .environment: return exists ? .blue : .orange
        case .appSupport:  return exists ? .green : .secondary
        case .notSet:      return .secondary
        }
    }

    @ViewBuilder
    private func sourceTag(
        for source: PanoProvisioningStatus.Source,
        exists: Bool
    ) -> some View {
        let label = sourceTagLabel(for: source)
        let color = sourceTagColor(for: source, exists: exists)
        Text(label)
            .font(.caption2)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
            .accessibilityLabel("Path source: \(label)")
    }

    // MARK: - Persistence

    private func scheduleSave() {
        saveDebounceTask?.cancel()
        let snapModels   = modelsDir
        let snapOrt      = ortDylibPath
        saveDebounceTask = Task {
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled else { return }
            let ud = UserDefaults.standard
            ud.set(snapModels.isEmpty ? nil : snapModels,
                   forKey: PanoProvisioningDefaults.modelsDirKey)
            ud.set(snapOrt.isEmpty ? nil : snapOrt,
                   forKey: PanoProvisioningDefaults.ortDylibPathKey)
            panoSettingsLog.info("saved pano settings: modelsDir=\(snapModels.isEmpty ? "(none)" : snapModels, privacy: .public) ortDylib=\(snapOrt.isEmpty ? "(none)" : snapOrt, privacy: .public)")
            refreshStatus()
        }
    }

    private func refreshStatus() {
        status = provisioning.status()
    }
}

// MARK: - Provision model

/// Drives the "Download & Install" action: runs `PanoProvisioner` and
/// publishes progress to the view. MainActor-isolated so SwiftUI state
/// updates are safe; the provisioner's progress callbacks (off the main
/// actor) hop back here.
@MainActor
@Observable
final class PanoProvisionModel {
    enum State: Equatable {
        case idle
        case running(fraction: Double, label: String)
        case failed(String)
    }

    private(set) var state: State = .idle
    private var isRunning = false

    /// True while a download is in flight (drives Merge-flow gating).
    var isBusy: Bool { if case .running = state { return true } else { return false } }

    /// Run a provisioning pass. On success, `onComplete` runs on the main
    /// actor (the view refreshes its status). Re-entrant-safe; call again to
    /// retry after a failure.
    func download(onComplete: @escaping @MainActor () -> Void) async {
        guard !isRunning else { return }
        isRunning = true
        state = .running(fraction: 0, label: "Starting…")
        let provisioner = PanoProvisioner()
        do {
            try await provisioner.provision { progress in
                Task { @MainActor in
                    // Ignore stray late ticks once we've left .running.
                    if case .running = self.state {
                        self.state = .running(fraction: progress.fraction, label: progress.label)
                    }
                }
            }
            state = .idle
            isRunning = false
            onComplete()
        } catch {
            state = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
            isRunning = false
        }
    }
}

// MARK: - Previews

#Preview("Not configured") {
    PanoSettingsView()
        .frame(width: 520, height: 480)
}
