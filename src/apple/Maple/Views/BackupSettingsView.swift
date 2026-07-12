// BackupSettingsView.swift
//
// Settings → Photo Library backup panel. Configures server + library +
// inclusion toggles, surfaces engine progress via BackupStatusPanel.
//
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §7.

import SwiftUI
import OSLog
import MapleCore
import MapleBackup

private let settingsLog = Logger(subsystem: "app.justmaple.aperture", category: "Backup.SettingsView")

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
  ///
  /// Persisted in UserDefaults so it survives view re-appearances AND app
  /// launches — without persistence, going from this panel to the Browse
  /// view and back resets the flag and the Start Backup button reappears
  /// even though the engine has been running the whole time.
  ///
  /// Lifecycle: set to `true` when the user explicitly taps Start Backup,
  /// AND auto-restored on appear when `EngineHost.shared.queue.snapshot()`
  /// reports non-empty work. There is currently no clearing path —
  /// once set, the Status section stays visible for the rest of the
  /// install's lifetime. The Pause button in BackupStatusPanel stops
  /// the engine but intentionally leaves this flag set so the user can
  /// see Resume / progress remnants without having to re-tap Start.
  /// If a future ticket wants a "hide the panel" affordance, write
  /// `Self.saveHasStarted(false)` from that code path.
  @State private var hasStarted = BackupSettingsView.loadHasStarted()

  private static let hasStartedKey = "maple.backup.settings.hasStarted.v1"

  private static func loadHasStarted() -> Bool {
    UserDefaults.standard.bool(forKey: hasStartedKey)
  }

  private static func saveHasStarted(_ value: Bool) {
    UserDefaults.standard.set(value, forKey: hasStartedKey)
  }

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
      .listRowBackground(MapleTokens.surface)
      Section("Inclusion") {
        Toggle("Live Photos", isOn: $settings.includeLivePhotos)
        Toggle("Videos", isOn: $settings.includeVideos)
        Toggle("Bursts (every frame)", isOn: $settings.includeBursts)
        Toggle("iCloud Shared Library", isOn: $settings.includeSharedLibrary)
        Toggle("Shared Albums", isOn: $settings.includeSharedAlbums)
      }
      .listRowBackground(MapleTokens.surface)
      Section("Network") {
        Toggle("Wi-Fi only", isOn: $settings.wifiOnly)
      }
      .listRowBackground(MapleTokens.surface)
      if hasStarted {
        Section("Status") {
          BackupStatusPanel()
        }
        .listRowBackground(MapleTokens.surface)
      }
      Section {
        Button {
          Task {
            settingsLog.info("Start button tapped — saving + starting engine")
            settings.save()
            await EngineHost.shared.start(settings: settings)
            settingsLog.info("EngineHost.start returned engine=\(EngineHost.shared.engine != nil ? "ok" : "nil") err=\(EngineHost.shared.lastStartError ?? "none", privacy: .public)")
            // Kick the PhotoKit walk + change observer. Without this the
            // engine boots against an empty queue and the user just sees
            // 'No photos queued' even though they configured everything.
            // MapleApp's .task fires this on app launch when settings
            // were already configured — but if the user configures here
            // and taps Start, that path was never hit and we need to
            // kick it ourselves. The walk itself runs off the main
            // thread (ChangeObserverWiring.enqueueAllNew → Task.detached)
            // so this call is non-blocking for the UI.
            if let serverBaseURL = URL(string: settings.serverURL),
               let storage = try? DeviceIdentity.defaultStorageURL(),
               let deviceId = try? DeviceIdentity.current(storageURL: storage) {
              // This is the explicit user Start/Restart path — pass
              // retryFailed:true so a Restart resets and re-enqueues
              // .failedRetry tasks (the user chose "Retry failed + new").
              // The launch path in MapleApp and the periodic walk stay
              // new-only.
              settingsLog.info("kicking ChangeObserverWiring.start deviceId=\(deviceId, privacy: .public) retryFailed=true")
              ChangeObserverWiring.start(deviceId: deviceId, settings: settings,
                                         libraryId: settings.libraryId,
                                         serverBaseURL: serverBaseURL,
                                         retryFailed: true)
            } else {
              settingsLog.error("ChangeObserverWiring NOT started — failed to resolve serverBaseURL or DeviceIdentity")
            }
            hasStarted = true
            Self.saveHasStarted(true)
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
    .mapleSettingsBackground()
    .task(id: settings.serverURL) {
      await reloadLibraries()
    }
    .task {
      // If the engine is already running (queued items from a prior session),
      // surface the status section without making the user re-tap Start.
      // Persisted hasStarted handles the "engine drained but the user wants
      // it back" case; this catches the "engine restarted by the host"
      // case for free.
      let snapshot = await EngineHost.shared.queue.snapshot()
      if !snapshot.isEmpty && !hasStarted {
        hasStarted = true
        Self.saveHasStarted(true)
      }
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
      Text("No servers paired. Go to Settings → Cloud to add one.")
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
    // Fixed sample — safe filename, real PathFormatter call. Shows the geo
    // layout: <year>/<State|Country>/<Town/City||Place>/<file>.
    let sampleDate = ISO8601DateFormatter().date(from: "2024-03-15T12:00:00Z") ?? Date()
    let formatted = (try? PathFormatter.format(
      captureDate: sampleDate,
      location: ["California", "San Francisco"],
      filename: "IMG_0420.HEIC")) ?? "2024/California/San Francisco/IMG_0420.HEIC"
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

// MARK: - Previews
//
// Issue #139 — backup settings. Internal state is all `@State`-local;
// no factory injection needed. The Form renders against whatever
// `BackupSettings.load()` returns (likely `.defaults` in a clean
// preview env).

#Preview("Default") {
    BackupSettingsView()
        .frame(width: 480, height: 700)
}

#Preview("Path preview only") {
    BackupPathPreview(libraryName: "MyLibrary", rootFolder: "iPhone")
        .padding()
}
