// PanoSettingsView.swift — Settings → Pano tab.
//
// Panorama merge works out of the box with the classical matcher (#4554).
// The "Use ML matcher" toggle (off by default, persisted under
// PanoProvisioningDefaults.useMLMatcherKey) opts into ALIKED + LightGlue:
// turning it on runs `PanoProvisioner` to download + SHA-verify the models
// (and, on macOS, the ONNX Runtime dylib) into Application Support; turning
// it off keeps the files but stitches with the classical matcher again.
//
// The path fields are optional overrides for the ML runtime (Settings →
// MAPLE_PANO_MODELS / ORT_DYLIB_PATH → Application Support), saved with an
// 800ms debounce like BackupSettingsView, and shown only while ML is on.
//
// Ticket: #1241 / #1234 M6 / #4554

import MapleCore
import MapleUI
import OSLog
import SwiftUI

private let panoSettingsLog = Logger(
  subsystem: "app.justmaple.aperture",
  category: "Pano.SettingsView"
)

// MARK: - PanoSettingsView

struct PanoSettingsView: View {
  @State private var modelsDir: String =
    UserDefaults.standard.string(
      forKey: PanoProvisioningDefaults.modelsDirKey) ?? ""
  @State private var ortDylibPath: String =
    UserDefaults.standard.string(
      forKey: PanoProvisioningDefaults.ortDylibPathKey) ?? ""
  @State private var status: PanoProvisioningStatus = PanoProvisioning().status()
  @State private var saveDebounceTask: Task<Void, Never>?
  @State private var provisionModel = PanoProvisionModel()
  @AppStorage(PanoProvisioningDefaults.useMLMatcherKey) private var useMLMatcher = false

  private let provisioning = PanoProvisioning()

  var body: some View {
    Form {
      matcherSection
      if useMLMatcher {
        pathsSection
        resolutionOrderSection
      }
    }
    .formStyle(.grouped)
    .mapleSettingsBackground()
    .onChange(of: modelsDir) { _, _ in scheduleSave() }
    .onChange(of: ortDylibPath) { _, _ in scheduleSave() }
    .onChange(of: useMLMatcher) { _, enabled in
      if enabled { downloadIfNeeded() }
    }
    .task { refreshStatus() }
  }

  // MARK: - Matcher section

  private var mlReady: Bool { PanoProvisioner.isReady(status) }

  @ViewBuilder
  private var matcherSection: some View {
    Section {
      Toggle(isOn: $useMLMatcher) {
        VStack(alignment: .leading, spacing: 2) {
          Text("Use ML matcher")
          Text("Better alignment, downloads ~\(approxDownloadMB) MB")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      .disabled(provisionModel.isBusy)
      .accessibilityIdentifier("pano.settings.useMLMatcher")
      .accessibilityHint(
        "Off uses the built-in classical matcher. On downloads the ML models and uses them once installed.")

      HStack(spacing: 10) {
        MuiIcon(name: engineIcon, size: .sm)
          .foregroundStyle(engineTint)
          .imageScale(.medium)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(engineTitle)
            .font(.subheadline.weight(.medium))
          Text(statusDescription)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      .padding(.vertical, 2)
      .accessibilityElement(children: .combine)

      if useMLMatcher {
        provisionActionView
      }
    } header: {
      Text("Matcher")
    }
    .listRowBackground(MapleTokens.surface)
  }

  private var engineTitle: String {
    switch (useMLMatcher, mlReady) {
    case (false, _): return "Classical matcher"
    case (true, true): return "ML matcher ready"
    case (true, false): return "ML matcher not installed"
    }
  }

  private var engineIcon: String {
    useMLMatcher && !mlReady ? "exclamationmark.triangle.fill" : "checkmark.circle.fill"
  }

  private var engineTint: Color {
    useMLMatcher && !mlReady ? Color.orange : Color.green
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
              Label {
                Text("Download & Install")
              } icon: {
                MuiIcon(name: "arrow_circle_down", size: .sm)
              }
            }
            .accessibilityIdentifier("pano.settings.download")
            Text(
              "Downloads \(downloadSummary) (~\(approxDownloadMB) MB) and installs "
                + "them into the default Application Support location automatically."
            )
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
    case .running(let fraction, let label):
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
      .accessibilityLabel(
        "Installing panorama components, \(Int((fraction * 100).rounded())) percent")
    case .failed(let message):
      VStack(alignment: .leading, spacing: 6) {
        Text(message)
          .font(.caption)
          .foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
        Button {
          startDownload()
        } label: {
          Label {
            Text("Retry")
          } icon: {
            MuiIcon(name: "refresh", size: .sm)
          }
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

  private func downloadIfNeeded() {
    refreshStatus()
    guard !mlReady, PanoProvisioner.canAutoProvision(status) else { return }
    startDownload()
  }

  private func startDownload() {
    Task {
      await provisionModel.download {
        refreshStatus()
      }
    }
  }

  private var statusDescription: String {
    guard useMLMatcher else {
      return "Panorama merge works without any download."
    }
    if mlReady {
      return "Merges use ALIKED + LightGlue."
    }
    let missing = [
      status.modelsDirExists ? nil : "models",
      // iOS embeds the ONNX Runtime at build time — never "missing" there.
      Self.needsOrtDylib && !status.ortDylibExists ? "ONNX Runtime" : nil,
    ].compactMap { $0 }
    return "Missing: " + missing.joined(separator: ", ")
      + ". Merges use the classical matcher until these are installed."
  }

  private static var needsOrtDylib: Bool {
    #if os(macOS)
      return true
    #else
      return false
    #endif
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
        Text(
          "Directory containing \(PanoProvisioning.modelFilenameList). "
            + "Leave blank to use the MAPLE_PANO_MODELS environment variable or "
            + "the default Application Support location."
        )
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
        Text(
          "Path to libonnxruntime.dylib version ≥ 1.23. "
            + "Leave blank to use the ORT_DYLIB_PATH environment variable or "
            + "the default Application Support location."
        )
        .font(.caption)
        .foregroundStyle(.secondary)
      }
      .padding(.vertical, 2)

    } header: {
      Text("Paths")
    } footer: {
      Text(
        "These paths are optional overrides for the ML matcher. Most users can leave "
          + "them blank: turning on the ML matcher downloads the required files into "
          + "the default Application Support location."
      )
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
    case .settings: return "settings"
    case .environment: return "env"
    case .appSupport: return "default"
    case .notSet: return "not set"
    }
  }

  private func sourceTagColor(
    for source: PanoProvisioningStatus.Source,
    exists: Bool
  ) -> Color {
    switch source {
    case .settings: return exists ? .green : .orange
    case .environment: return exists ? .blue : .orange
    case .appSupport: return exists ? .green : .secondary
    case .notSet: return .secondary
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
    let snapModels = modelsDir
    let snapOrt = ortDylibPath
    saveDebounceTask = Task {
      try? await Task.sleep(for: .milliseconds(800))
      guard !Task.isCancelled else { return }
      let ud = UserDefaults.standard
      ud.set(
        snapModels.isEmpty ? nil : snapModels,
        forKey: PanoProvisioningDefaults.modelsDirKey)
      ud.set(
        snapOrt.isEmpty ? nil : snapOrt,
        forKey: PanoProvisioningDefaults.ortDylibPathKey)
      panoSettingsLog.info(
        "saved pano settings: modelsDir=\(snapModels.isEmpty ? "(none)" : snapModels, privacy: .public) ortDylib=\(snapOrt.isEmpty ? "(none)" : snapOrt, privacy: .public)"
      )
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
