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

    public func load(domain: String) -> AuthTokens? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "\(serviceBase).\(domain)",
            kSecAttrAccessGroup: Self.accessGroup,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
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
        let base: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "\(serviceBase).\(domain)",
            kSecAttrAccessGroup: Self.accessGroup,
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData] = data
        add[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(add as CFDictionary, nil)
        if status != errSecSuccess {
            keychainLogger.error("SecItemAdd failed for domain \(domain, privacy: .public): OSStatus \(status)")
        }
    }

    public func remove(domain: String) {
        let q: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "\(serviceBase).\(domain)",
            kSecAttrAccessGroup: Self.accessGroup,
        ]
        SecItemDelete(q as CFDictionary)
    }
}
