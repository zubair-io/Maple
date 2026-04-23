// SMBCredentialStore.swift — Keychain-backed credential storage for SMB shares.
//
// Modeled after `SelfHostedCredentialStore` so the API is symmetric; the
// storage backend is Keychain (`kSecClassInternetPassword`) keyed on
// (host, share, username) per share so the user can save more than one share.
//
// The Password is stored as UTF-8 bytes; retrieval decodes back to String.
// Failures are non-fatal — the UI prompts for credentials on read miss.

import Foundation
import Security

// MARK: - SMBCredentialStore

/// Persistent credential store for SMB shares. Actor-isolated so reads and
/// writes can't race each other.
public actor SMBCredentialStore {
    public static let shared = SMBCredentialStore()

    /// Service string used for all SMB credential queries.
    public static let service = "app.justmaple.maple.smb"

    /// Shape persisted alongside the password so the UI can list saved shares
    /// without the user having to retype host/share on every open.
    public struct SavedShare: Sendable, Hashable, Codable {
        public let host: String
        public let share: String
        public let username: String

        public init(host: String, share: String, username: String) {
            self.host = host
            self.share = share
            self.username = username
        }
    }

    /// UserDefaults key for the list of saved shares (host+share+username
    /// only — passwords live in Keychain).
    private static let savedSharesKey = "app.justmaple.maple.smb.savedShares"

    public init() {}

    // MARK: - Public API

    /// Persist a full set of credentials. Writes the password to Keychain
    /// and appends the share metadata to the saved-shares UserDefaults list.
    public func save(_ credentials: SMBSource.Credentials) throws {
        try Self.keychainSet(
            service: Self.service,
            account: Self.accountKey(credentials),
            password: credentials.password
        )
        var saved = Self.loadSavedShares()
        let entry = SavedShare(
            host: credentials.host,
            share: credentials.share,
            username: credentials.username
        )
        if !saved.contains(entry) {
            saved.append(entry)
            Self.writeSavedShares(saved)
        }
    }

    /// Fetch credentials for a saved share. Returns `nil` when no password
    /// is on file (e.g. first-open, or the user cleared Keychain).
    public func credentials(for share: SavedShare) -> SMBSource.Credentials? {
        let account = Self.accountKey(
            host: share.host, share: share.share, username: share.username
        )
        guard let password = Self.keychainGet(
            service: Self.service, account: account
        ) else { return nil }
        return SMBSource.Credentials(
            host: share.host,
            share: share.share,
            username: share.username,
            password: password
        )
    }

    /// The shares the user has saved. Read synchronously from UserDefaults.
    public func savedShares() -> [SavedShare] {
        Self.loadSavedShares()
    }

    /// Remove a saved share from the list and delete its Keychain entry.
    public func delete(_ share: SavedShare) {
        var saved = Self.loadSavedShares()
        saved.removeAll { $0 == share }
        Self.writeSavedShares(saved)
        let account = Self.accountKey(
            host: share.host, share: share.share, username: share.username
        )
        Self.keychainDelete(service: Self.service, account: account)
    }

    // MARK: - Keys

    private static func accountKey(_ c: SMBSource.Credentials) -> String {
        accountKey(host: c.host, share: c.share, username: c.username)
    }
    private static func accountKey(host: String, share: String, username: String) -> String {
        "\(username)@\(host)/\(share)"
    }

    // MARK: - UserDefaults helpers

    private static func loadSavedShares() -> [SavedShare] {
        guard let data = UserDefaults.standard.data(forKey: savedSharesKey) else { return [] }
        return (try? JSONDecoder().decode([SavedShare].self, from: data)) ?? []
    }

    private static func writeSavedShares(_ shares: [SavedShare]) {
        if let data = try? JSONEncoder().encode(shares) {
            UserDefaults.standard.set(data, forKey: savedSharesKey)
        }
    }

    // MARK: - Keychain primitives

    @discardableResult
    private static func keychainSet(service: String, account: String, password: String) throws -> Bool {
        guard let data = password.data(using: .utf8) else { return false }
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        // Delete then add — simpler than the SecItemUpdate branch.
        SecItemDelete(query as CFDictionary)
        var addQuery = query
        addQuery[kSecValueData as String] = data
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        if status != errSecSuccess {
            throw SMBCredentialStoreError.keychain(status: status)
        }
        return true
    }

    private static func keychainGet(service: String, account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String:  true,
            kSecMatchLimit as String:  kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func keychainDelete(service: String, account: String) {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

// MARK: - Error

public enum SMBCredentialStoreError: Error, LocalizedError, Equatable {
    case keychain(status: OSStatus)

    public var errorDescription: String? {
        switch self {
        case .keychain(let s): return "Keychain error (OSStatus \(s))"
        }
    }
}
