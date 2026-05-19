import Foundation
import OSLog

private let configLogger = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "config")

public struct FileProviderDomainConfig: Codable, Equatable, Sendable {
    public let domainIdentifier: String
    public let displayName: String
    public let serverURL: URL

    public init(domainIdentifier: String, displayName: String, serverURL: URL) {
        self.domainIdentifier = domainIdentifier
        self.displayName = displayName
        self.serverURL = serverURL
    }
}

/// File-based domain config under the App Group container.
///
/// We used to store this in `UserDefaults(suiteName:)` but CFPreferences
/// rejects `kCFPreferencesAnyUser + container` from non-sandboxed clients
/// ("Using kCFPreferencesAnyUser with a container is only allowed for
/// System Containers, detaching from cfprefsd"). File storage works for
/// both sandboxed sides (host writes, extension reads) via the App Group
/// container at `~/Library/Group Containers/<group>/FileProviderConfig/<domain>.json`.
public final class FileProviderConfig: @unchecked Sendable {
    public static let appGroupSuiteName = "group.app.justmaple.aperture"
    /// Legacy `UserDefaults` key prefix used before the JSON-file layout.
    /// Pre-PR-#79 we stored each domain's config under
    /// `UserDefaults(suiteName: appGroupSuiteName)` keyed by
    /// `legacyDefaultsKeyPrefix + domain`. Retained for the one-shot
    /// migration in `load(domain:)`.
    static let legacyDefaultsKeyPrefix = "fileprovider.domain."
    private let directory: URL
    private let legacyDefaults: UserDefaults?
    private let lock = NSLock()

    /// Resolved storage directory under the App Group container.
    /// Tests can override by passing a tmp `directory`. When omitted,
    /// derives `<App Group container>/FileProviderConfig/`.
    ///
    /// `legacyDefaults` is the `UserDefaults` instance that may still
    /// hold pre-PR-#79 entries. Production callers leave it nil — the
    /// initializer opens `UserDefaults(suiteName: appGroupSuiteName)`
    /// for them. Tests pass a unique-suite instance so the migration
    /// path can be exercised without touching the real shared store.
    public init(directory: URL? = nil, legacyDefaults: UserDefaults? = nil) {
        if let dir = directory {
            self.directory = dir
        } else if let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroupSuiteName) {
            self.directory = container.appendingPathComponent("FileProviderConfig", isDirectory: true)
        } else {
            // App Group container unavailable (no entitlement). Fall back
            // to the user's caches dir — matches the prior "degraded but
            // not crashing" stance. Cross-process sharing won't work, so
            // the extension will boot dormant; surface this in the log.
            configLogger.error("App Group \(Self.appGroupSuiteName, privacy: .public) container unavailable — falling back to caches dir; extension will not see writes")
            let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSTemporaryDirectory())
            self.directory = caches.appendingPathComponent("FileProviderConfig", isDirectory: true)
        }
        if let legacyDefaults {
            self.legacyDefaults = legacyDefaults
        } else {
            // Same suite the pre-PR-#79 code wrote into. Returns nil only
            // when CFPreferences refuses the suite (sandbox edge cases);
            // in that case there is nothing to migrate from.
            self.legacyDefaults = UserDefaults(suiteName: Self.appGroupSuiteName)
        }
        try? FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
        // dir contains the user's home path; redact.
        configLogger.notice("FileProviderConfig dir=\(self.directory.path, privacy: .private)")
    }

    private func fileURL(domain: String) -> URL {
        directory.appendingPathComponent("\(domain).json", isDirectory: false)
    }

    public func load(domain: String) -> FileProviderDomainConfig? {
        lock.lock(); defer { lock.unlock() }
        let url = fileURL(domain: domain)
        let exists = FileManager.default.fileExists(atPath: url.path)
        configLogger.notice("load domain=\(domain, privacy: .public) path=\(url.path, privacy: .public) exists=\(exists, privacy: .public)")
        if exists {
            do {
                let data = try Data(contentsOf: url)
                return try JSONDecoder().decode(FileProviderDomainConfig.self, from: data)
            } catch {
                configLogger.error("load read/decode failed for \(domain, privacy: .public): \(String(describing: error), privacy: .public)")
                return nil
            }
        }
        // Fall back to the legacy `UserDefaults` suite. Pre-PR-#79 we
        // wrote each domain's config under `fileprovider.domain.<id>` in
        // `UserDefaults(suiteName: appGroupSuiteName)`. Try to read it,
        // re-save via the new file layout, and only then clear the
        // legacy entry — if the file write fails we leave the suite
        // entry intact so the next launch retries.
        return migrateLegacyDefaultsLocked(domain: domain)
    }

    /// Caller must hold `lock`.
    private func migrateLegacyDefaultsLocked(domain: String) -> FileProviderDomainConfig? {
        guard let defaults = legacyDefaults else { return nil }
        let legacyKey = Self.legacyDefaultsKeyPrefix + domain
        guard let data = defaults.data(forKey: legacyKey) else { return nil }
        let decoded: FileProviderDomainConfig
        do {
            decoded = try JSONDecoder().decode(FileProviderDomainConfig.self, from: data)
        } catch {
            configLogger.error("legacy UserDefaults entry for \(domain, privacy: .public) failed to decode: \(String(describing: error), privacy: .public)")
            return nil
        }
        // Write the new file before clearing the legacy entry — if the
        // write fails (disk full, container missing) the next launch
        // gets another shot at migrating.
        let url = fileURL(domain: domain)
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            configLogger.error("legacy-migrate write failed for \(domain, privacy: .public): \(String(describing: error), privacy: .public) — leaving legacy entry in place")
            return decoded
        }
        guard FileManager.default.fileExists(atPath: url.path) else {
            configLogger.error("legacy-migrate write reported success but file missing for \(domain, privacy: .public) — leaving legacy entry in place")
            return decoded
        }
        defaults.removeObject(forKey: legacyKey)
        configLogger.notice("migrated legacy UserDefaults config to file for domain=\(domain, privacy: .public)")
        return decoded
    }

    public func save(_ config: FileProviderDomainConfig) {
        lock.lock(); defer { lock.unlock() }
        guard let data = try? JSONEncoder().encode(config) else {
            configLogger.error("encode failed for domain \(config.domainIdentifier, privacy: .public)")
            return
        }
        do {
            try data.write(to: fileURL(domain: config.domainIdentifier), options: .atomic)
            configLogger.notice("saved config for domain \(config.domainIdentifier, privacy: .public) at \(self.directory.path, privacy: .public)")
        } catch {
            configLogger.error("write failed for domain \(config.domainIdentifier, privacy: .public): \(String(describing: error), privacy: .public)")
        }
    }

    public func remove(domain: String) {
        lock.lock(); defer { lock.unlock() }
        try? FileManager.default.removeItem(at: fileURL(domain: domain))
    }

    public func allDomains() -> [FileProviderDomainConfig] {
        lock.lock(); defer { lock.unlock() }
        let entries = (try? FileManager.default.contentsOfDirectory(at: directory,
                                                                     includingPropertiesForKeys: nil)) ?? []
        return entries
            .filter { $0.pathExtension == "json" }
            .compactMap { try? Data(contentsOf: $0) }
            .compactMap { try? JSONDecoder().decode(FileProviderDomainConfig.self, from: $0) }
    }
}
