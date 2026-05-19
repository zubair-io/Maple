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
    public static let defaultServiceBase = "app.justmaple.aperture.fileprovider"
    private let serviceBase: String
    private let accessGroupOverride: String?

    /// Production callers leave `serviceBase` at the default — overriding
    /// is only useful in tests, where each case uses a UUID-suffixed
    /// service name so concurrent keychain operations don't collide and
    /// a leaked entry on a developer machine can't be confused with a
    /// real Maple item.
    ///
    /// `accessGroup` likewise is for tests only — the production access
    /// group requires the shared-keychain entitlement, which is absent
    /// in plain `swift test` host-less bundles. Passing nil for the
    /// access group runs queries against the unscoped keychain.
    public init(serviceBase: String = FileProviderTokensStore.defaultServiceBase,
                accessGroup: String? = FileProviderTokensStore.accessGroup) {
        self.serviceBase = serviceBase
        self.accessGroupOverride = accessGroup
    }

    /// macOS has two keychain backends: legacy "login" (unsandboxed default)
    /// and "data protection" (sandboxed default, iOS-shaped). Access groups
    /// only work in data protection. Unsandboxed host + sandboxed extension
    /// would otherwise land in different keychains and never share tokens.
    /// Pin both sides to data protection via `kSecUseDataProtectionKeychain`.
    private func baseQuery(service: String) -> [CFString: Any] {
        var q: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecUseDataProtectionKeychain: true,
        ]
        if let group = accessGroupOverride {
            q[kSecAttrAccessGroup] = group
        }
        return q
    }

    /// Pre-PR-#79 query shape — omits `kSecUseDataProtectionKeychain`
    /// so it targets the same backend the old code wrote into. Used
    /// only by the one-shot migration in `load(domain:)` and the
    /// matching `SecItemDelete` once the new entry has landed.
    private func legacyBaseQuery(service: String) -> [CFString: Any] {
        var q: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
        ]
        if let group = accessGroupOverride {
            q[kSecAttrAccessGroup] = group
        }
        return q
    }

    public func load(domain: String) -> AuthTokens? {
        let service = "\(serviceBase).\(domain)"
        var query = baseQuery(service: service)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var ref: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &ref)
        if status == errSecSuccess, let data = ref as? Data,
           let tokens = try? JSONDecoder().decode(AuthTokens.self, from: data) {
            return tokens
        }
        // Fall back to the legacy keychain shape. Pre-PR-#79 we ran the
        // same query without `kSecUseDataProtectionKeychain`, which on
        // macOS lands in a different backend (legacy "login" for
        // unsandboxed hosts). An upgrading install will have tokens
        // there that the data-protection query can't see.
        return migrateLegacyKeychain(domain: domain, service: service)
    }

    private func migrateLegacyKeychain(domain: String, service: String) -> AuthTokens? {
        var legacyQuery = legacyBaseQuery(service: service)
        legacyQuery[kSecReturnData] = true
        legacyQuery[kSecMatchLimit] = kSecMatchLimitOne
        var ref: AnyObject?
        let status = SecItemCopyMatching(legacyQuery as CFDictionary, &ref)
        guard status == errSecSuccess, let data = ref as? Data else { return nil }
        guard let tokens = try? JSONDecoder().decode(AuthTokens.self, from: data) else {
            keychainLogger.error("legacy keychain entry for \(domain, privacy: .public) failed to decode — leaving in place")
            return nil
        }
        // Re-save through the data-protection path. `save` is best-effort
        // (returns Void) so verify the new entry is readable before we
        // delete the legacy one. If the write didn't take, leave the
        // legacy item so the next launch retries.
        save(tokens, domain: domain)
        var verifyQuery = baseQuery(service: service)
        verifyQuery[kSecReturnData] = true
        verifyQuery[kSecMatchLimit] = kSecMatchLimitOne
        var verifyRef: AnyObject?
        let verifyStatus = SecItemCopyMatching(verifyQuery as CFDictionary, &verifyRef)
        guard verifyStatus == errSecSuccess else {
            keychainLogger.error("legacy-migrate save unverifiable for \(domain, privacy: .public): OSStatus \(verifyStatus) — leaving legacy entry in place")
            return tokens
        }
        // Only now is it safe to drop the legacy entry. Delete uses the
        // legacy shape so it targets the same backend the item lives in
        // — a data-protection delete would no-op against a legacy item.
        let deleteStatus = SecItemDelete(legacyBaseQuery(service: service) as CFDictionary)
        if deleteStatus != errSecSuccess && deleteStatus != errSecItemNotFound {
            keychainLogger.error("legacy-migrate delete failed for \(domain, privacy: .public): OSStatus \(deleteStatus)")
        }
        keychainLogger.notice("migrated legacy keychain tokens to data-protection for domain=\(domain, privacy: .public)")
        return tokens
    }

    public func save(_ tokens: AuthTokens, domain: String) {
        guard let data = try? JSONEncoder().encode(tokens) else {
            keychainLogger.error("encode failed for domain \(domain, privacy: .public)")
            return
        }
        let base = baseQuery(service: "\(serviceBase).\(domain)")
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
        SecItemDelete(baseQuery(service: "\(serviceBase).\(domain)") as CFDictionary)
    }
}
