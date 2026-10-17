#if os(iOS)
  import Foundation
  import MapleCore
  import Security

  /// Keeps successful credentials, and ambiguous in-flight requests, across phone relaunches.
  /// A request that may already have reached the server is never silently minted twice (#3617).
  actor WatchPairingPending {
    struct Record: Codable, Sendable {
      let id: UUID
      let server: URL
      let grant: WatchPairingGrant?

      func resume(id: UUID, server: URL, currentTokens: AuthTokens?) throws -> WatchPairingGrant {
        guard self.id == id, self.server == server else { throw PairingError.anotherRequest }
        guard let grant else { throw PairingError.uncertain }
        guard WatchPairingPending.sameAccount(grant: grant, currentTokens: currentTokens) else {
          throw PairingError.accountChanged
        }
        return grant
      }
    }

    enum PairingError: LocalizedError, Equatable {
      case anotherRequest, uncertain, authorizationEnded, accountChanged

      var errorDescription: String? {
        switch self {
        case .anotherRequest:
          return "Finish the previous Watch pairing, or reset that attempt on your iPhone."
        case .uncertain:
          return
            "The server may have created a Watch session. Review paired devices in web Settings → Account before resetting this attempt."
        case .authorizationEnded:
          return "Open Apple Watch setup on your iPhone and tap Allow Pairing."
        case .accountChanged:
          return
            "This pairing belongs to a different account. Sign in to that account or reset the pending attempt."
        }
      }
    }

    private var cached: Record?
    private var loaded = false

    func pending() throws -> Record? {
      if loaded { return cached }
      var query = baseQuery
      query[kSecReturnData as String] = true
      query[kSecMatchLimit as String] = kSecMatchLimitOne
      var item: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &item)
      if status == errSecItemNotFound {
        loaded = true
        return nil
      }
      guard status == errSecSuccess, let data = item as? Data else {
        throw NSError(domain: "WatchPairing", code: Int(status))
      }
      cached = try JSONDecoder().decode(Record.self, from: data)
      loaded = true
      return cached
    }

    func grant(
      id: UUID, server: URL,
      isAuthorized: @escaping @MainActor @Sendable () -> Bool
    ) async throws -> WatchPairingGrant {
      if let record = try pending() {
        return try record.resume(
          id: id, server: server, currentTokens: TokenStore.load(server: server))
      }
      guard let original = try TokenStore.load(server: server) else {
        throw PairingError.authorizationEnded
      }
      let http = AuthenticatedHTTPClient(
        server: server, urlSession: .shared,
        tokensProvider: { try? TokenStore.load(server: server) },
        onTokensRefreshed: {
          guard try TokenStore.replace($0, server: server, ifCurrentIs: original) else {
            throw CancellationError()
          }
        },
        onSignOut: { _ = TokenStore.clear(server: server, ifCurrentIs: original) },
        refreshExecutor: BackgroundExecution())
      _ = try await http.accessTokenForURL()
      guard await isAuthorized(), let tokens = try TokenStore.load(server: server),
        Self.sameAccount(original, tokens)
      else {
        throw PairingError.authorizationEnded
      }
      try save(Record(id: id, server: server, grant: nil))
      // From this point a transport error is ambiguous. Retain the intent so retries
      // cannot create orphaned sessions. The user can inspect/revoke it on the server.
      let mint: DeviceSessionMint
      do {
        mint = try await AuthClient(server: server).mintDeviceSession(
          accessToken: tokens.access, refreshToken: tokens.refresh,
          label: "Apple Watch", platform: .watchOS)
      } catch let error as AuthClientError where error.isAuthFailure {
        // An explicit authentication refusal did not create a device session.
        try clear()
        throw error
      }
      let grant = WatchPairingGrant(
        id: id, server: server,
        tokens: AuthTokens(access: mint.access_token, refresh: mint.refresh_token))
      // Save server-committed state BEFORE any cancellation/authorization guard.
      try save(Record(id: id, server: server, grant: grant))
      return grant
    }

    func acknowledge(id: UUID) throws -> URL? {
      guard let record = try pending() else { return nil }
      guard record.id == id, record.grant != nil else { throw PairingError.anotherRequest }
      try clear()
      return record.server
    }

    func clear() throws {
      let status = SecItemDelete(baseQuery as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw NSError(domain: "WatchPairing", code: Int(status))
      }
      cached = nil
      loaded = true
    }

    private func save(_ record: Record) throws {
      // Keep the minted grant in memory even when Keychain becomes unavailable.
      cached = record
      loaded = true
      let data = try JSONEncoder().encode(record)
      let updates = [kSecValueData as String: data]
      let status = SecItemUpdate(baseQuery as CFDictionary, updates as CFDictionary)
      if status == errSecItemNotFound {
        var insert = baseQuery
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let inserted = SecItemAdd(insert as CFDictionary, nil)
        guard inserted == errSecSuccess else {
          throw NSError(domain: "WatchPairing", code: Int(inserted))
        }
      } else if status != errSecSuccess {
        throw NSError(domain: "WatchPairing", code: Int(status))
      }
    }

    /// Bind resumption to the account that owns the minted credential, even if
    /// the phone signed out and another person signed in to the same server.
    nonisolated static func belongsToCurrentAccount(_ grant: WatchPairingGrant) -> Bool {
      sameAccount(grant: grant, currentTokens: try? TokenStore.load(server: grant.server))
    }

    nonisolated static func sameAccount(grant: WatchPairingGrant, currentTokens: AuthTokens?)
      -> Bool
    {
      sameAccount(grant.tokens, currentTokens)
    }

    nonisolated static func sameAccount(_ original: AuthTokens, _ currentTokens: AuthTokens?)
      -> Bool
    {
      guard let current = currentTokens,
        let owner = subject(original.access), let signedIn = subject(current.access)
      else { return false }
      return owner == signedIn
    }

    private nonisolated static func subject(_ token: String) -> String? {
      let parts = token.split(separator: ".")
      guard parts.count == 3 else { return nil }
      let base = parts[1].replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
      let padded = base + String(repeating: "=", count: (4 - base.count % 4) % 4)
      guard let data = Data(base64Encoded: padded),
        let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let subject = payload["sub"] as? String, !subject.isEmpty
      else { return nil }
      return subject
    }

    private var baseQuery: [String: Any] {
      [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "app.justmaple.aperture.watch-pairing",
        kSecAttrAccount as String: "pending-grant",
        kSecUseDataProtectionKeychain as String: true,
      ]
    }
  }
#endif
