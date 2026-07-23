// src/apple/Packages/MapleCore/Sources/MapleCore/Auth/CloudTokenPersistence.swift
import Foundation

/// Standard persistence hooks for authenticated cloud clients. `TokenStore`
/// now uses the shared Keychain access group directly, so every Apple process
/// reads and writes this same item; there is deliberately no mirror task.
public enum CloudTokenPersistence {
  public static func persistRotated(_ tokens: AuthTokens, server: URL) throws {
    try TokenStore.save(tokens, server: server)
  }

  public static func clear(server: URL) {
    TokenStore.clear(server: server)
  }
}
