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
// follow-up: #1234 M6 — auto-download/bundle models + ORT so users
//   don't need to configure paths manually.
//
// Ticket: #1241 / Part of #1234

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

    private let provisioning = PanoProvisioning()

    var body: some View {
        Form {
            statusSection
            pathsSection
            resolutionOrderSection
        }
        .formStyle(.grouped)
        .onChange(of: modelsDir) { _, _ in scheduleSave() }
        .onChange(of: ortDylibPath) { _, _ in scheduleSave() }
        .task { refreshStatus() }
    }

    // MARK: - Status section

    @ViewBuilder
    private var statusSection: some View {
        Section {
            HStack(spacing: 10) {
                Image(systemName: status.isProvisioned
                      ? "checkmark.circle.fill"
                      : "exclamationmark.triangle.fill")
                    .foregroundStyle(status.isProvisioned ? Color.green : Color.orange)
                    .imageScale(.medium)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(status.isProvisioned ? "Ready" : "Not configured")
                        .font(.subheadline.weight(.medium))
                        .accessibilityLabel(status.isProvisioned
                            ? "Panorama models and runtime are configured and ready"
                            : "Panorama models or runtime are not configured")
                    Text(statusDescription)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .combine)
        } header: {
            Text("Status")
        }
    }

    private var statusDescription: String {
        if status.isProvisioned {
            return "Panorama stitching is ready to use."
        }
        var missing: [String] = []
        if !status.modelsDirExists { missing.append("models directory") }
        if !status.ortDylibExists  { missing.append("ONNX Runtime dylib") }
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
            // follow-up: #1234 M6 — auto-download/bundle models + ORT
            Text("Auto-download and bundling of models and the ONNX Runtime are planned for a future release (M6 of #1234). Until then, configure the paths above or place the files in their default Application Support locations.")
                .font(.caption2)
                .foregroundStyle(Color(white: 0.5))
        }
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

// MARK: - Previews

#Preview("Not configured") {
    PanoSettingsView()
        .frame(width: 520, height: 480)
}
