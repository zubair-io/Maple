// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderTokensStore.swift
import Foundation
import OSLog
import Security

private let keychainLogger = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "keychain")

public struct FileProviderTokensStore: Sendable {
    /// Fully qualified Keychain access group. Build-time variables like
    /// `$(AppIdentifierPrefix)` are NOT substituted at runtime — the
    /// Keychain entitlement on the binary carries the resolved
    /// team-prefixed value, and `SecItem*` APIs must be passed the
    /// exact same string. Tracks `DEVELOPMENT_TEAM = QREP66JW5U` in
    /// `src/apple/Maple.xcodeproj/project.pbxproj`; update both
    /// together if the team identifier ever changes.
    public static let accessGroup = "QREP66JW5U.app.justmaple.aperture.shared"
    private let serviceBase = "app.justmaple.aperture.fileprovider"

    public init() {}

    /// macOS has two keychain backends: legacy "login" (unsandboxed default)
    /// and "data protection" (sandboxed default, iOS-shaped). Access groups
    /// only work in data protection. Unsandboxed host + sandboxed extension
    /// would otherwise land in different keychains and never share tokens.
    /// Pin both sides to data protection via `kSecUseDataProtectionKeychain`.
    private static func baseQuery(service: String) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccessGroup: accessGroup,
            kSecUseDataProtectionKeychain: true,
        ]
    }

    public func load(domain: String) -> AuthTokens? {
        var query = Self.baseQuery(service: "\(serviceBase).\(domain)")
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var ref: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &ref)
        guard status == errSecSuccess, let data = ref as? Data else { return nil }
        return try? JSONDecoder().decode(AuthTokens.self, from: data)
    }

    public func save(_ tokens: AuthTokens, domain: String) {
        guard let data = try? JSONEncoder().encode(tokens) else {
            keychainLogger.error("encode failed for domain \(domain, privacy: .public)")
            return
        }
        let base = Self.baseQuery(service: "\(serviceBase).\(domain)")
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData] = data
        add[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        if status != errSecSuccess {
            keychainLogger.error("SecItemAdd failed for domain \(domain, privacy: .public): OSStatus \(status)")
        }
    }

    public func remove(domain: String) {
        SecItemDelete(Self.baseQuery(service: "\(serviceBase).\(domain)") as CFDictionary)
    }
}
