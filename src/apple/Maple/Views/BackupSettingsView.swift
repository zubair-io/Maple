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
  @State private var saveDebounceTask: Task<Void, Never>?

  var body: some View {
    Form {
      Section("Destination") {
        TextField("Server URL", text: $settings.serverURL)
          .textContentType(.URL)
          .accessibilityIdentifier("backup.serverURL")
        TextField("Library ID", text: $settings.libraryId)
          .accessibilityIdentifier("backup.libraryId")
        TextField("Root folder", text: $settings.rootFolder)
          .accessibilityIdentifier("backup.rootFolder")
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
      Section("Status") {
        BackupStatusPanel()
      }
    }
    .formStyle(.grouped)
    .onChange(of: settings) { _, new in
      saveDebounceTask?.cancel()
      saveDebounceTask = Task {
        try? await Task.sleep(for: .milliseconds(800))
        if Task.isCancelled { return }
        new.save()
        await EngineHost.shared.start(settings: new)
      }
    }
  }
}
