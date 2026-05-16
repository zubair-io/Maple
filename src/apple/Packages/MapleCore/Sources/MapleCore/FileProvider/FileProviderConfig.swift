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

public final class FileProviderConfig: @unchecked Sendable {
    public static let appGroupSuiteName = "group.app.justmaple.aperture"
    private let defaults: UserDefaults
    private let prefix = "fileprovider.domain."

    /// `defaults` overrides the App Group container — used by tests so they
    /// don't touch the real shared store. When omitted, opens the App Group
    /// suite; if that's unavailable (entitlement missing / sandboxed away)
    /// falls back to `.standard`. The extension reading from `.standard` in
    /// the main app's process will see nothing and stay dormant, which is
    /// the same behaviour as "no config" — degraded but not crashing.
    public init(defaults: UserDefaults? = nil) {
        if let d = defaults {
            self.defaults = d
            return
        }
        if let group = UserDefaults(suiteName: Self.appGroupSuiteName) {
            self.defaults = group
        } else {
            configLogger.error("App Group \(Self.appGroupSuiteName, privacy: .public) unavailable — falling back to .standard; extension will not see writes")
            self.defaults = .standard
        }
    }

    public func load(domain: String) -> FileProviderDomainConfig? {
        guard let data = defaults.data(forKey: prefix + domain) else { return nil }
        return try? JSONDecoder().decode(FileProviderDomainConfig.self, from: data)
    }

    public func save(_ config: FileProviderDomainConfig) {
        guard let data = try? JSONEncoder().encode(config) else {
            configLogger.error("encode failed for domain \(config.domainIdentifier, privacy: .public)")
            return
        }
        defaults.set(data, forKey: prefix + config.domainIdentifier)
    }

    public func remove(domain: String) {
        defaults.removeObject(forKey: prefix + domain)
    }

    public func allDomains() -> [FileProviderDomainConfig] {
        defaults.dictionaryRepresentation().keys
            .filter { $0.hasPrefix(prefix) }
            .compactMap { defaults.data(forKey: $0) }
            .compactMap { try? JSONDecoder().decode(FileProviderDomainConfig.self, from: $0) }
    }
}
