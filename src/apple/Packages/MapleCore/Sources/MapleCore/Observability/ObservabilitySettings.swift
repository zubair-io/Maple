// ObservabilitySettings.swift
//
// User-configurable settings for the native telemetry exporter. Persisted to
// UserDefaults so the choice survives launches. Mirrors BackupSettings: a
// small Codable struct with `save()`/`load()` on a versioned key.
//
// Holds two things:
//   1. The base URL string of the paired self-hosted server whose
//      `/api/observability/config` we use. Empty until the user picks one.
//   2. A local `enabled` toggle — a client-side master switch the user
//      controls independently of the server's `enabled` field. Telemetry only
//      ships when BOTH this AND the server config's `enabled` are true. This
//      lets a user opt their device out without touching the server.
//
// Note: the resolved SigNoz config (endpoint, ingestion key, signal toggles)
// does NOT live here — it lives in ObservabilityConfigCache, fetched from the
// server. These settings are just the user's local choices.

import Foundation

public struct ObservabilitySettings: Equatable, Codable, Sendable {

    /// Base URL of the paired self-hosted server providing the SigNoz config.
    /// Empty until the user picks one in Settings → Observability.
    public var serverURL: String

    /// Local master switch. Defaults to true so that picking a server is the
    /// only step needed to start telemetry; flip off to opt this device out
    /// without changing the server config.
    public var enabled: Bool

    public init(serverURL: String, enabled: Bool) {
        self.serverURL = serverURL
        self.enabled = enabled
    }

    public static let defaults = ObservabilitySettings(
        serverURL: "",
        enabled: true)

    /// True once the user has picked a server — the minimum to start a config
    /// fetch + bootstrap.
    public var isConfigured: Bool {
        !serverURL.isEmpty
    }

    // MARK: - Persistence

    private static let key = "maple.observability.settings.v1"

    public func save(to defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        defaults.set(data, forKey: Self.key)
    }

    public static func load(from defaults: UserDefaults = .standard) -> ObservabilitySettings? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(ObservabilitySettings.self, from: data)
    }
}
