// BackupSettingsView.swift
//
// Settings → Photo Library backup panel. Configures server + library +
// inclusion toggles, surfaces engine progress via BackupStatusPanel.
//
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §7.

import SwiftUI
import MapleCore
import MapleBackup

struct BackupSettingsView: View {
  @State private var settings: BackupSettings = BackupSettings.load() ?? .defaults
  @State private var registry = CloudServerRegistry.shared
  @State private var libraries: [CloudFolder] = []
  @State private var libraryLoadError: String?
  @State private var isLoadingLibraries = false
  @State private var saveDebounceTask: Task<Void, Never>?
  /// Becomes true the first time the user taps "Start Backup" (or on
  /// appear if the engine is already running from a prior session). Gates
  /// the Status section so the user doesn't see "No photos queued" before
  /// they've actually started anything.
  @State private var hasStarted = false

  private var selectedServerURL: URL? {
    URL(string: settings.serverURL)
  }

  var body: some View {
    Form {
      Section("Destination") {
        serverPicker
        libraryPicker
        rootFolderPicker
        pathPreview
      }
      Section("Inclusion") {
        Toggle("Live Photos", isOn: $settings.includeLivePhotos)
        Toggle("Videos", isOn: $settings.includeVideos)
        Toggle("Bursts (every frame)", isOn: $settings.includeBursts)
        Toggle("iCloud Shared Library", isOn: $settings.includeSharedLibrary)
        Toggle("Shared Albums", isOn: $settings.includeSharedAlbums)
      }
      Section("Network") {
        Toggle("Wi-Fi only", isOn: $settings.wifiOnly)
      }
      if hasStarted {
        Section("Status") {
          BackupStatusPanel()
        }
      }
      Section {
        Button {
          Task {
            settings.save()
            await EngineHost.shared.start(settings: settings)
            hasStarted = true
          }
        } label: {
          Text(hasStarted ? "Restart Backup" : "Start Backup")
            .frame(maxWidth: .infinity)
        }
        .disabled(!settings.isConfigured)
        .buttonStyle(.borderedProminent)
        .accessibilityIdentifier("backup.startButton")
      }
    }
    .formStyle(.grouped)
    .task(id: settings.serverURL) {
      await reloadLibraries()
    }
    .task {
      // If the engine is already running (queued items from a prior session),
      // surface the status section without making the user re-tap Start.
      let snapshot = await EngineHost.shared.queue.snapshot()
      if !snapshot.isEmpty { hasStarted = true }
    }
    .onChange(of: settings) { _, new in
      // Persist edits eagerly (debounced) so the user's picks survive
      // app restarts. Do NOT auto-restart the engine — only the explicit
      // Start Backup button starts (or restarts) the upload run.
      saveDebounceTask?.cancel()
      saveDebounceTask = Task {
        try? await Task.sleep(for: .milliseconds(800))
        if Task.isCancelled { return }
        new.save()
      }
    }
  }

  // MARK: - Subviews

  @ViewBuilder
  private var serverPicker: some View {
    if registry.servers.isEmpty {
      Text("No servers paired. Switch to the Self Hosted tab to add one.")
        .font(.callout)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("backup.noServers")
    } else {
      Picker("Server", selection: $settings.serverURL) {
        Text("Select a server").tag("")
        ForEach(registry.servers, id: \.absoluteString) { url in
          Text(registry.displayName(for: url) ?? url.host ?? url.absoluteString)
            .tag(url.absoluteString)
        }
      }
      .accessibilityIdentifier("backup.serverURL")
    }
  }

  @ViewBuilder
  private var libraryPicker: some View {
    if selectedServerURL != nil && !settings.serverURL.isEmpty {
      if isLoadingLibraries {
        HStack {
          Text("Library")
            .foregroundStyle(.secondary)
          Spacer()
          ProgressView()
            .controlSize(.small)
        }
      } else if let err = libraryLoadError {
        VStack(alignment: .leading, spacing: 6) {
          HStack {
            Text("Library")
              .foregroundStyle(.secondary)
            Spacer()
            Button("Retry") {
              Task { await reloadLibraries() }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityIdentifier("backup.libraryRetry")
          }
          Text(err)
            .font(.caption)
            .foregroundStyle(.red)
        }
      } else if libraries.isEmpty {
        Text("No libraries found on this server.")
          .font(.callout)
          .foregroundStyle(.secondary)
      } else {
        Picker("Library", selection: $settings.libraryId) {
          Text("Select a library").tag("")
          ForEach(libraries) { folder in
            Text(folder.displayName).tag(folder.id)
          }
        }
        .accessibilityIdentifier("backup.libraryId")
      }
    }
  }

  @ViewBuilder
  private var rootFolderPicker: some View {
    Picker("Root", selection: $settings.rootFolder) {
      Text("Library root").tag("")
      Text("iPhotoBackups").tag("iPhotoBackups")
    }
    .pickerStyle(.segmented)
    .accessibilityIdentifier("backup.rootFolder")
  }

  @ViewBuilder
  private var pathPreview: some View {
    if settings.isConfigured,
       let selectedLib = libraries.first(where: { $0.id == settings.libraryId }) {
      BackupPathPreview(libraryName: selectedLib.displayName,
                        rootFolder: settings.rootFolder)
    }
  }

  // MARK: - Data loading

  private func reloadLibraries() async {
    libraryLoadError = nil
    guard let serverURL = selectedServerURL, !settings.serverURL.isEmpty else {
      libraries = []
      return
    }
    isLoadingLibraries = true
    defer { isLoadingLibraries = false }
    do {
      let client = try await CloudFoldersListing.client(for: serverURL)
      libraries = try await client.listFolders()
    } catch {
      libraryLoadError = error.localizedDescription
      libraries = []
    }
  }
}

// MARK: - BackupPathPreview

/// Renders a sample backup path so the user can see exactly what their
/// destination picks produce before committing. Uses PathFormatter so
/// the preview matches the real engine output byte-for-byte.
private struct BackupPathPreview: View {
  let libraryName: String
  let rootFolder: String

  var body: some View {
    // Fixed sample — safe filename, real PathFormatter call.
    let sampleDate = ISO8601DateFormatter().date(from: "2024-03-15T12:00:00Z") ?? Date()
    let formatted = (try? PathFormatter.format(
      captureDate: sampleDate,
      location: "Tokyo",
      filename: "IMG_0420.HEIC")) ?? "2024/Tokyo/03-15/IMG_0420.HEIC"
    let trail = rootFolder.isEmpty ? formatted : "\(rootFolder)/\(formatted)"

    return VStack(alignment: .leading, spacing: 4) {
      Text("Backup destination preview")
        .font(.caption)
        .foregroundStyle(.secondary)
      Text("\(libraryName)/\(trail)")
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(.secondary)
        .lineLimit(nil)
        .multilineTextAlignment(.leading)
        .accessibilityIdentifier("backup.pathPreview")
    }
    .padding(.vertical, 2)
  }
}
