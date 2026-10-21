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
      let lookup: [String: Any] = [
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
      ]
      let query = baseQuery.merging(lookup) { $1 }
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
      // A refresh re-reads the keychain under TokenStore's refresh lock, so it
      // can't restore credentials a concurrent sign-out cleared (#4873). A
      // rejected refresh is left to the app's own client: clearing here alone
      // would strand its session as signed in.
      let http = AuthenticatedHTTPClient(
        server: server, urlSession: .shared,
        tokensProvider: { try? TokenStore.load(server: server) },
        onTokensRefreshed: { try CloudTokenPersistence.persistRotated($0, server: server) },
        onSignOut: {},
        refreshExecutor: BackgroundExecution())
      _ = try await http.accessTokenForURL()
      guard await isAuthorized(), let tokens = try TokenStore.load(server: server),
        Self.sameAccount(original, tokens)
      else {
        throw PairingError.authorizationEnded
      }
      try save(Record(id: id, server: server, grant: nil))
      // From here a transport error is ambiguous: keep the intent so a retry
      // can't mint a second, orphaned session.
      let mint: DeviceSessionMint
      do {
        mint = try await Self.mint(server: server, proof: tokens)
      } catch let error as AuthClientError where error.isAuthFailure {
        // A refused proof created no session. Another Maple process may have
        // rotated the refresh token in between; present the new one once.
        guard let rotated = try TokenStore.load(server: server), rotated != tokens,
          Self.sameAccount(original, rotated)
        else {
          try clear()
          throw error
        }
        do {
          mint = try await Self.mint(server: server, proof: rotated)
        } catch let retryError as AuthClientError where retryError.isAuthFailure {
          try clear()
          throw retryError
        }
      }
      let grant = WatchPairingGrant(
        id: id, server: server,
        tokens: AuthTokens(access: mint.access_token, refresh: mint.refresh_token))
      // Save server-committed state BEFORE any cancellation/authorization guard.
      try save(Record(id: id, server: server, grant: grant))
      return grant
    }

    private static func mint(server: URL, proof: AuthTokens) async throws -> DeviceSessionMint {
      try await AuthClient(server: server).mintDeviceSession(
        accessToken: proof.access, refreshToken: proof.refresh,
        label: "Apple Watch", platform: .watchOS)
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
        // The app's own group, not the shared one its extensions can read.
        kSecAttrAccessGroup as String: "QREP66JW5U.app.justmaple.aperture",
      ]
    }
  }
#endif
