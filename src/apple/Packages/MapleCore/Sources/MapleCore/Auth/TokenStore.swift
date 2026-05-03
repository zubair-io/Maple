// src/apple/Packages/MapleCore/Sources/MapleCore/Auth/TokenStore.swift
import Foundation
import Security

public struct AuthTokens: Codable, Equatable {
  public let access: String
  public let refresh: String
  public init(access: String, refresh: String) { self.access = access; self.refresh = refresh }
}

public enum TokenStore {
  private static let service = "app.justmaple.maple.auth"

  public static func save(_ tokens: AuthTokens, server: URL) throws {
    let data = try JSONEncoder().encode(tokens)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: server.absoluteString,
    ]
    SecItemDelete(query as CFDictionary)
    var add = query
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(add as CFDictionary, nil)
    guard status == errSecSuccess else { throw NSError(domain: "TokenStore", code: Int(status)) }
  }

  public static func load(server: URL) throws -> AuthTokens? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: server.absoluteString,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = item as? Data else {
      throw NSError(domain: "TokenStore", code: Int(status))
    }
    return try JSONDecoder().decode(AuthTokens.self, from: data)
  }

  public static func clear(server: URL) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: server.absoluteString,
    ]
    SecItemDelete(query as CFDictionary)
  }
}
