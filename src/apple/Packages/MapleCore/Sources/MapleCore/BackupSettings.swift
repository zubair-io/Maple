// BackupSettings.swift
//
// User-configurable settings for the PhotoKit backup engine. Persisted to
// UserDefaults so the main app, the MapleBackupAgent, and any iOS
// BGProcessingTask invocation all see the same configuration.
//
// Lives in MapleCore (not MapleBackup) so consumers can load it without
// depending on the engine module.
//
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §7.

import Foundation

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

    // MARK: - Persistence

    private static let key = "maple.backup.settings.v1"

    public func save(to defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        defaults.set(data, forKey: Self.key)
    }

    public static func load(from defaults: UserDefaults = .standard) -> BackupSettings? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(BackupSettings.self, from: data)
    }
}
