// ObservabilityConfigCache.swift
//
// On-disk cache for `GET /api/observability/config`, keyed by server host
// (+ port). Mirrors CloudFoldersCache exactly — same directory layout, same
// AuthCacheKey, same advisory write-on-success / read-on-fallback contract.
//
// Why this cache is load-bearing (not just advisory like the folders one):
// the app must NOT ping the server on every launch just to discover whether
// telemetry is on. ObservabilityController reads THIS cache at launch and
// bootstraps swift-otel from it immediately, then background-refreshes. So the
// cache is the launch-time source of truth; the network is the refresh path.
//
// The cached payload includes the SigNoz ingestion key (a secret). This is
// consistent with how the rest of the cloud DTOs are cached — the Caches
// directory is per-app and not world-readable on iOS/macOS. The key is never
// logged. There is no separate Keychain storage for it.

import Foundation
import MapleCloudKit

public enum ObservabilityConfigCache {
    private static let folder = "observability-config"

    /// `Caches/app.justmaple.aperture/observability-config/<key>.json`.
    /// Key includes host AND port and is sanitised for filesystem use — see
    /// `AuthCacheKey.make` for the rationale.
    private static func url(for server: URL) -> URL? {
        guard let key = AuthCacheKey.make(for: server) else { return nil }
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        return caches
            .appendingPathComponent("app.justmaple.aperture", isDirectory: true)
            .appendingPathComponent(folder, isDirectory: true)
            .appendingPathComponent("\(key).json")
    }

    public static func load(server: URL) -> ObservabilityConfig? {
        guard let url = url(for: server),
              FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url),
              let config = try? JSONDecoder().decode(ObservabilityConfig.self, from: data)
        else { return nil }
        return config
    }

    public static func save(_ config: ObservabilityConfig, server: URL) {
        guard let url = url(for: server) else { return }
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(config) {
            try? data.write(to: url, options: .atomic)
        }
    }

    public static func clear(server: URL) {
        guard let url = url(for: server) else { return }
        try? FileManager.default.removeItem(at: url)
    }
}
