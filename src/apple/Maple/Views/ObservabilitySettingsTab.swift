// ObservabilitySettingsTab.swift
//
// Settings → Observability panel. The user picks which paired self-hosted
// server's SigNoz config to use (a Picker over CloudServerRegistry.shared.servers,
// exactly like the Backup tab's server picker), toggles a local opt-in, and
// sees the resolved config the server handed back. The app exports logs +
// traces direct-to-SigNoz via swift-otel (ObservabilityController).
//
// Ticket #713. The server-picker half mirrors BackupSettingsView precisely.

import SwiftUI
import OSLog
import MapleCore

private let settingsLog = Logger(subsystem: "app.justmaple.aperture", category: "Observability.SettingsView")

struct ObservabilitySettingsTab: View {
  @State private var registry = CloudServerRegistry.shared
  @State private var controller = ObservabilityController.shared
  @State private var settings: ObservabilitySettings = ObservabilitySettings.load() ?? .defaults
  @State private var saveDebounceTask: Task<Void, Never>?

  private var selectedServerURL: URL? {
    URL(string: settings.serverURL)
  }

  var body: some View {
    Form {
      Section("Server") {
        serverPicker
      }
      .listRowBackground(MapleTokens.surface)
      Section("Telemetry") {
        Toggle("Send telemetry from this device", isOn: $settings.enabled)
          .accessibilityIdentifier("observability.enabled")
        Text("Logs, errors, and traces are sent directly to the SigNoz instance configured on the selected server. The ingestion key is stored only in this app's cache.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .listRowBackground(MapleTokens.surface)
      statusSection
      Section {
        Button {
          Task { await controller.refresh() }
        } label: {
          HStack {
            Text("Refresh now")
            if controller.isRefreshing {
              Spacer()
              ProgressView().controlSize(.small)
            }
          }
          .frame(maxWidth: .infinity)
        }
        .disabled(!settings.isConfigured || controller.isRefreshing)
        .accessibilityIdentifier("observability.refresh")
      }
    }
    .formStyle(.grouped)
    .mapleSettingsBackground()
    .onChange(of: settings.serverURL) { _, _ in
      // Server selection takes effect immediately (load cache + bootstrap +
      // kick refresh through the controller) AND is persisted.
      controller.selectServer(selectedServerURL)
      scheduleSave()
    }
    .onChange(of: settings.enabled) { _, newValue in
      controller.setEnabled(newValue)
      scheduleSave()
    }
  }

  // MARK: - Subviews

  @ViewBuilder
  private var serverPicker: some View {
    if registry.servers.isEmpty {
      Text("No servers paired. Go to Settings → Cloud to add one.")
        .font(.callout)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("observability.noServers")
    } else {
      Picker("Server", selection: $settings.serverURL) {
        Text("Select a server").tag("")
        ForEach(registry.servers, id: \.absoluteString) { url in
          Text(registry.displayName(for: url) ?? url.host ?? url.absoluteString)
            .tag(url.absoluteString)
        }
      }
      .accessibilityIdentifier("observability.serverURL")
    }
  }

  @ViewBuilder
  private var statusSection: some View {
    if settings.isConfigured {
      Section("Status") {
        if let config = controller.cachedConfig {
          LabeledContent("Exporting") {
            Text(controller.isExporting ? "Active" : "Inactive")
              .foregroundStyle(controller.isExporting ? .green : .secondary)
          }
          .accessibilityIdentifier("observability.status.exporting")

          LabeledContent("Endpoint") {
            Text(config.normalizedEndpoint ?? "Not set")
              .font(.system(.callout, design: .monospaced))
              .foregroundStyle(.secondary)
              .lineLimit(1)
              .truncationMode(.middle)
          }
          .accessibilityIdentifier("observability.status.endpoint")

          LabeledContent("Namespace") {
            Text(config.serviceNamespace)
              .foregroundStyle(.secondary)
          }

          LabeledContent("Traces") {
            Text(config.tracesEnabled ? "On" : "Off")
              .foregroundStyle(.secondary)
          }
          .accessibilityIdentifier("observability.status.traces")

          LabeledContent("Logs") {
            Text(config.logsEnabled ? "On" : "Off")
              .foregroundStyle(.secondary)
          }
          .accessibilityIdentifier("observability.status.logs")

          LabeledContent("Metrics") {
            Text(config.metricsEnabled ? "On" : "Off")
              .foregroundStyle(.secondary)
          }

          LabeledContent("Ingestion key") {
            Text(config.ingestionKeySet ? "Set" : "Not set")
              .foregroundStyle(.secondary)
          }
          .accessibilityIdentifier("observability.status.key")

          LabeledContent("Sample ratio") {
            Text(String(format: "%.2f", config.sampleRatio))
              .foregroundStyle(.secondary)
          }

          if let last = controller.lastRefresh {
            LabeledContent("Last refresh") {
              Text(last, format: .relative(presentation: .named))
                .foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("observability.status.lastRefresh")
          }

          if controller.pendingConfigChange {
            Text("The server's config changed. Relaunch Maple to apply the new telemetry settings.")
              .font(.caption)
              .foregroundStyle(.orange)
              .accessibilityIdentifier("observability.status.pendingChange")
          }
        } else if controller.isRefreshing {
          HStack {
            Text("Loading config…")
              .foregroundStyle(.secondary)
            Spacer()
            ProgressView().controlSize(.small)
          }
        } else {
          Text("No config cached yet. Tap Refresh now to fetch it from the server.")
            .font(.callout)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("observability.status.empty")
        }

        if let err = controller.lastRefreshError {
          Text(err)
            .font(.caption)
            .foregroundStyle(.red)
            .accessibilityIdentifier("observability.status.error")
        }
      }
      .listRowBackground(MapleTokens.surface)
    }
  }

  // MARK: - Persistence

  /// Debounced save of the local settings, mirroring BackupSettingsView. The
  /// controller already persists on selectServer/setEnabled, but we keep a
  /// local debounced save so the view's @State picks survive even if the
  /// controller path changes.
  private func scheduleSave() {
    saveDebounceTask?.cancel()
    let snapshot = settings
    saveDebounceTask = Task {
      try? await Task.sleep(for: .milliseconds(800))
      if Task.isCancelled { return }
      snapshot.save()
    }
  }
}

// MARK: - Previews

#Preview("Default") {
  ObservabilitySettingsTab()
    .frame(width: 520, height: 560)
}
