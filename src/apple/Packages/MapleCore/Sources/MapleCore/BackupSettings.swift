// BackupSettings.swift
//
// User-configurable settings for the PhotoKit backup engine. Persisted to
// UserDefaults so the main app, the MapleBackupAgent, and any iOS
// BGProcessingTask invocation all see the same configuration.
//
// Lives in MapleCore (not MapleBackup) so consumers can load it without
// depending on the engine module.
//
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §7.

import CryptoKit
import Foundation
import MapleBackup

public struct BackupSettings: Equatable, Codable, Sendable {

  /// Maple Cloud server base URL. Empty until the user configures one.
  public var serverURL: String

  /// Library id on the server (an ObjectId hex string).
  public var libraryId: String

  /// Folder relative to the library root where the backup tree lands.
  /// Empty string (the default) writes directly under the library root.
  /// Subdirectory values like `"iPhotoBackups"` are also accepted by
  /// callers that want to keep the imported tree out of the library's
  /// top level.
  public var rootFolder: String

  /// Both bytes and sidecar uploads are gated to Wi-Fi by default.
  public var wifiOnly: Bool

  /// Inclusion toggles — match spec §7.
  public var includeLivePhotos: Bool
  public var includeVideos: Bool
  public var includeBursts: Bool
  public var includeSharedLibrary: Bool
  public var includeSharedAlbums: Bool

  public init(
    serverURL: String,
    libraryId: String,
    rootFolder: String,
    wifiOnly: Bool,
    includeLivePhotos: Bool,
    includeVideos: Bool,
    includeBursts: Bool,
    includeSharedLibrary: Bool,
    includeSharedAlbums: Bool
  ) {
    self.serverURL = serverURL
    self.libraryId = libraryId
    self.rootFolder = rootFolder
    self.wifiOnly = wifiOnly
    self.includeLivePhotos = includeLivePhotos
    self.includeVideos = includeVideos
    self.includeBursts = includeBursts
    self.includeSharedLibrary = includeSharedLibrary
    self.includeSharedAlbums = includeSharedAlbums
  }

  /// Defaults match the spec §7 inclusion-toggle defaults.
  public static let defaults = BackupSettings(
    serverURL: "",
    libraryId: "",
    rootFolder: "",
    wifiOnly: true,
    includeLivePhotos: true,
    includeVideos: true,
    includeBursts: false,
    includeSharedLibrary: true,
    includeSharedAlbums: false)

  /// True when the user has picked a server and a library — the minimum
  /// to start the backup engine. EngineHost gates `.start(...)` on this.
  public var isConfigured: Bool {
    !serverURL.isEmpty && !libraryId.isEmpty
  }

  /// Backed-up state belongs to one destination. A different library must
  /// never inherit uploaded markers from the previous server/library.
  public var stateDatabaseFilename: String {
    let identity = Data("\(serverURL)\n\(libraryId)".utf8)
    let digest = SHA256.hash(data: identity).map { String(format: "%02x", $0) }.joined()
    return "backup-state-\(digest).sqlite"
  }

  public static var isStoppedByUser: Bool {
    get { isStoppedByUser(in: sharedDefaults) }
    set { setStoppedByUser(newValue, in: sharedDefaults) }
  }

  public static func isStoppedByUser(
    in defaults: UserDefaults = sharedDefaults, migratingFrom legacy: UserDefaults = .standard
  ) -> Bool {
    if defaults.object(forKey: stoppedKey) == nil, defaults !== legacy,
      let inherited = legacy.object(forKey: stoppedKey)
    {
      defaults.set(inherited, forKey: stoppedKey)
    }
    return defaults.bool(forKey: stoppedKey)
  }

  public static func setStoppedByUser(_ stopped: Bool, in defaults: UserDefaults = sharedDefaults) {
    defaults.set(stopped, forKey: stoppedKey)
  }

  // MARK: - Persistence

  /// The App Group suite every Apple process reads (#4717): before this,
  /// settings lived in each process's own `UserDefaults.standard`, so the
  /// macOS backup helper always exited with "no backup settings
  /// configured". Falls back to `.standard` only if the suite cannot be
  /// opened at all.
  public static var sharedDefaults: UserDefaults {
    UserDefaults(suiteName: BackupStorage.appGroupID) ?? .standard
  }

  private static let key = "maple.backup.settings.v1"
  private static let stoppedKey = "maple.backup.stoppedByUser"

  public func save(to defaults: UserDefaults = sharedDefaults) {
    guard let data = try? JSONEncoder().encode(self) else { return }
    defaults.set(data, forKey: Self.key)
  }

  /// Reads the shared suite; a suite that has never held settings inherits
  /// them once from the legacy per-process domain the app used to write.
  public static func load(
    from defaults: UserDefaults = sharedDefaults, migratingFrom legacy: UserDefaults = .standard
  ) -> BackupSettings? {
    if defaults.data(forKey: key) == nil, defaults !== legacy, let inherited = legacy.data(forKey: key) {
      defaults.set(inherited, forKey: key)
    }
    guard let data = defaults.data(forKey: key) else { return nil }
    return try? JSONDecoder().decode(BackupSettings.self, from: data)
  }
}
