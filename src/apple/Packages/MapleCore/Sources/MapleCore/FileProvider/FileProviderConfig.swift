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
/// System Containers, detaching from cfprefsd"). The host app needs to
/// run unsandboxed in local-dev builds (App Groups capability isn't on the
/// dev provisioning profile), so UserDefaults is off the table.
///
/// File storage is the right mechanism when BOTH sides are sandboxed
/// (the Release / shipping target):
/// - Sandboxed host writes to `~/Library/Group Containers/<group>/FileProviderConfig/<domain>.json`.
/// - Sandboxed extension reads from the same path.
///
/// During LOCAL DEV the host runs unsandboxed (see `Maple-Debug.entitlements`)
/// because the dev provisioning profile lacks the App Groups capability.
/// The sandboxed extension can then hit EPERM trying to read files the
/// unsandboxed host wrote — macOS's container manager doesn't bless
/// files written from outside the sandbox boundary. The
/// `devFallbackConfig` static on `FileProviderExtensionCore` bridges
/// that gap by reverse-deriving the config from the domain identifier
/// itself.
public final class FileProviderConfig: @unchecked Sendable {
    public static let appGroupSuiteName = "group.app.justmaple.aperture"
    private let directory: URL
    private let lock = NSLock()

    /// Resolved storage directory under the App Group container.
    /// Tests can override by passing a tmp `directory`. When omitted,
    /// derives `<App Group container>/FileProviderConfig/`.
    public init(directory: URL? = nil) {
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
        guard exists else { return nil }
        do {
            let data = try Data(contentsOf: url)
            return try JSONDecoder().decode(FileProviderDomainConfig.self, from: data)
        } catch {
            configLogger.error("load read/decode failed for \(domain, privacy: .public): \(String(describing: error), privacy: .public)")
            return nil
        }
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
