// src/apple/Packages/MapleCore/Sources/MapleCore/Auth/TokenStore.swift
import Foundation
import Security

public struct AuthTokens: Codable, Equatable, Sendable {
  public let access: String
  public let refresh: String
  public init(access: String, refresh: String) { self.access = access; self.refresh = refresh }
}

public enum TokenStore {
  private static let service = "app.justmaple.maple.auth"
  public static let accessGroup = "QREP66JW5U.app.justmaple.aperture.shared"

  /// Base query shared by save/load/clear. `kSecUseDataProtectionKeychain`
  /// is the load-bearing bit: iOS uses the data-protection keychain by
  /// default, but macOS defaults to the legacy file keychain — and the
  /// iOS-style `kSecAttrAccessible…` attribute below behaves inconsistently
  /// there. Without this flag the macOS app's delete-then-add in `save()`
  /// fails to overwrite (SecItemAdd returns errSecDuplicateItem because the
  /// delete didn't match the legacy item), so a fresh login never replaces
  /// the stored token and the app keeps sending a stale one — which the
  /// server rejects with "bad signature". Setting it true makes both
  /// platforms use the same keychain with the same semantics. It's the
  /// default on iOS, so this is a no-op there and corrective on macOS.
  private static func baseQuery(server: URL) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: server.absoluteString,
      kSecUseDataProtectionKeychain as String: true,
    ]
    // SwiftPM test runners are not signed with Maple's access-group
    // entitlement. Only request the shared group when the current executable
    // actually carries it; shipping app/extension/agent targets all do.
    if processHasSharedAccessGroup {
      query[kSecAttrAccessGroup as String] = accessGroup
    }
    return query
  }

  private static let processHasSharedAccessGroup: Bool = {
    #if os(macOS)
    guard let task = SecTaskCreateFromSelf(nil),
          let value = SecTaskCopyValueForEntitlement(
            task,
            "keychain-access-groups" as CFString,
            nil
          ) as? [String]
    else { return false }
    return value.contains(accessGroup)
    #else
    // iOS-family app and extension targets are always signed with the shared
    // access group; SecTask entitlement inspection is unavailable there.
    return true
    #endif
  }()

  public static func save(_ tokens: AuthTokens, server: URL) throws {
    let data = try JSONEncoder().encode(tokens)
    let base = baseQuery(server: server)
    SecItemDelete(base as CFDictionary)
    var add = base
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    var status = SecItemAdd(add as CFDictionary, nil)
    if status == errSecDuplicateItem {
      // The delete didn't remove the existing item (keychain quirk / race).
      // Update it in place rather than leaving the stale value behind.
      status = SecItemUpdate(
        base as CFDictionary,
        [kSecValueData as String: data] as CFDictionary
      )
    }
    guard status == errSecSuccess else { throw NSError(domain: "TokenStore", code: Int(status)) }
  }

  public static func load(server: URL) throws -> AuthTokens? {
    var query = baseQuery(server: server)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = item as? Data else {
      throw NSError(domain: "TokenStore", code: Int(status))
    }
    return try JSONDecoder().decode(AuthTokens.self, from: data)
  }

  public static func clear(server: URL) {
    SecItemDelete(baseQuery(server: server) as CFDictionary)
  }
}
