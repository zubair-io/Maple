#if os(macOS)
  import Foundation
  import Security

  /// Kept across app launches so copied client configurations stay valid.
  /// Uses the app's Keychain, never a preference or an environment variable.
  actor AgentMCPTokenStore {
    static let shared = AgentMCPTokenStore()
    private let service: String

    init(service: String = "\(Bundle.main.bundleIdentifier ?? "app.justmaple.aperture").mcp") {
      self.service = service
    }

    func loadOrCreate() throws -> String {
      let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: "localhost",
      ]
      var lookup = query
      lookup[kSecReturnData as String] = true
      lookup[kSecMatchLimit as String] = kSecMatchLimitOne
      var item: CFTypeRef?
      let found = SecItemCopyMatching(lookup as CFDictionary, &item)
      if found == errSecSuccess, let data = item as? Data,
        let token = String(data: data, encoding: .utf8), token.count == 64,
        token.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
      {
        return token
      }
      if found == errSecSuccess {
        let deleted = SecItemDelete(query as CFDictionary)
        guard deleted == errSecSuccess || deleted == errSecItemNotFound else {
          throw failure(deleted)
        }
      } else if found != errSecItemNotFound {
        throw failure(found)
      }
      var random = [UInt8](repeating: 0, count: 32)
      let generated = random.withUnsafeMutableBytes {
        SecRandomCopyBytes(kSecRandomDefault, $0.count, $0.baseAddress!)
      }
      guard generated == errSecSuccess else { throw failure(generated) }
      let token = random.map { String(format: "%02x", $0) }.joined()
      var insertion = query
      insertion[kSecValueData as String] = Data(token.utf8)
      let saved = SecItemAdd(insertion as CFDictionary, nil)
      guard saved == errSecSuccess else { throw failure(saved) }
      return token
    }

    private func failure(_ status: OSStatus) -> NSError {
      NSError(
        domain: NSOSStatusErrorDomain, code: Int(status),
        userInfo: [
          NSLocalizedDescriptionKey: SecCopyErrorMessageString(status, nil) as String?
            ?? "Keychain could not load the MCP credential."
        ])
    }
  }
#endif
