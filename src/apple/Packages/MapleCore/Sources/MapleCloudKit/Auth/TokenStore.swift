// src/apple/Packages/MapleCore/Sources/MapleCore/Auth/TokenStore.swift
import Foundation
import Security

#if canImport(Darwin)
  import Darwin
#endif

public struct AuthTokens: Codable, Equatable, Sendable {
  public let access: String
  public let refresh: String
  public init(access: String, refresh: String) {
    self.access = access
    self.refresh = refresh
  }
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
    #if os(watchOS)
      // The Watch holds its own device session in its private keychain (#3617).
      return false
    #elseif os(macOS)
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

  @TaskLocal private static var heldLockServers: Set<URL> = []
  private static let generationLock = NSLock()
  nonisolated(unsafe) private static var mutationGenerations: [URL: UInt64] = [:]
  nonisolated(unsafe) static var clearUnlockedObserverForTesting: (@Sendable (URL) -> Void)?

  public static func reserveMutationGeneration(for server: URL) -> UInt64 {
    generationLock.lock()
    defer { generationLock.unlock() }
    let next = (mutationGenerations[server] ?? 0) &+ 1
    mutationGenerations[server] = next
    return next
  }

  public static func invalidateMutationGeneration(_ generation: UInt64, for server: URL) {
    generationLock.lock()
    defer { generationLock.unlock() }
    if mutationGenerations[server] == generation {
      mutationGenerations[server] = generation &+ 1
    }
  }

  private static func isCurrentMutationGeneration(_ generation: UInt64, for server: URL) -> Bool {
    generationLock.lock()
    defer { generationLock.unlock() }
    return (mutationGenerations[server] ?? 0) == generation
  }

  /// Update in place first, add only when nothing exists yet. The former
  /// delete-then-add left the item absent for a moment, and any other
  /// Apple process (File Provider, Quick Look, backup agent) that read the
  /// Keychain in that window saw "signed out" (#4716).
  ///
  /// Every credential writer (`save` and `clear`) serializes through the
  /// cross-process App Group refresh lock (#4873) so a sign-out, server
  /// removal, or new pairing cannot slip between `AuthenticatedHTTPClient`'s
  /// pre-persist generation check and its `onTokensRefreshed` write. When
  /// `AuthenticatedHTTPClient.refresh` already holds the lock for `server`
  /// on this task, the `@TaskLocal` guard avoids re-opening and re-locking
  /// the file.
  public static func save(_ tokens: AuthTokens, server: URL) throws {
    if heldLockServers.contains(server) {
      try saveUnlocked(tokens, server: server)
      return
    }
    let generation = reserveMutationGeneration(for: server)
    try withAcquiredLockIfNeeded(server: server) {
      guard isCurrentMutationGeneration(generation, for: server) else { return }
      try saveUnlocked(tokens, server: server)
    }
  }

  /// Async credential writer that awaits the per-server cross-process refresh
  /// lock via `Task.sleep` rather than blocking the caller's thread (#4873).
  /// Call from `@MainActor` / async contexts (`AuthSession`, pairing flows).
  public static func saveAsync(
    _ tokens: AuthTokens,
    server: URL,
    generation: UInt64? = nil
  ) async throws {
    if heldLockServers.contains(server) {
      try saveUnlocked(tokens, server: server)
      return
    }
    let targetGeneration = generation ?? reserveMutationGeneration(for: server)
    try await withRefreshLock(server: server) {
      guard isCurrentMutationGeneration(targetGeneration, for: server) else { return }
      try saveUnlocked(tokens, server: server)
    }
  }

  private static func saveUnlocked(_ tokens: AuthTokens, server: URL) throws {
    let data = try JSONEncoder().encode(tokens)
    let base = baseQuery(server: server)
    let updated = SecItemUpdate(
      base as CFDictionary,
      [kSecValueData as String: data] as CFDictionary
    )
    guard updated == errSecItemNotFound else {
      guard updated == errSecSuccess else {
        throw NSError(domain: "TokenStore", code: Int(updated))
      }
      return
    }
    var add = base
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let added = SecItemAdd(add as CFDictionary, nil)
    if added == errSecSuccess { return }
    // Two processes can both see "not found" and race the add; the loser
    // must still land its rotation (the server already consumed the
    // predecessor token), so update the winner's item instead of failing.
    guard added == errSecDuplicateItem else {
      throw NSError(domain: "TokenStore", code: Int(added))
    }
    let retried = SecItemUpdate(
      base as CFDictionary,
      [kSecValueData as String: data] as CFDictionary
    )
    guard retried == errSecSuccess else {
      throw NSError(domain: "TokenStore", code: Int(retried))
    }
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
    if heldLockServers.contains(server) {
      clearUnlocked(server: server)
      return
    }
    let generation = reserveMutationGeneration(for: server)
    do {
      try withAcquiredLockIfNeeded(server: server) {
        guard isCurrentMutationGeneration(generation, for: server) else { return }
        clearUnlocked(server: server)
      }
    } catch {
      // Never leave credentials in the Keychain if the lock file could not be
      // opened or lock acquisition timed out, unless a newer save/register
      // superseded this clear while it was waiting.
      if isCurrentMutationGeneration(generation, for: server) {
        clearUnlocked(server: server)
      }
    }
  }

  /// Async credential clear that awaits the per-server cross-process refresh
  /// lock via `Task.sleep` rather than blocking the caller's thread (#4873).
  public static func clearAsync(server: URL, generation: UInt64? = nil) async {
    if heldLockServers.contains(server) {
      clearUnlocked(server: server)
      return
    }
    let targetGeneration = generation ?? reserveMutationGeneration(for: server)
    do {
      try await withRefreshLock(server: server) {
        guard isCurrentMutationGeneration(targetGeneration, for: server) else { return }
        clearUnlocked(server: server)
      }
    } catch {
      if isCurrentMutationGeneration(targetGeneration, for: server) {
        clearUnlocked(server: server)
      }
    }
  }

  private static func clearUnlocked(server: URL) {
    clearUnlockedObserverForTesting?(server)
    _ = SecItemDelete(baseQuery(server: server) as CFDictionary)
  }

  // MARK: - Cross-process credential lock (#4873)

  /// Runs `operation` under the per-server cross-process App Group refresh
  /// lock, marking `server` as held in task-local storage so nested
  /// `TokenStore.save` / `TokenStore.clear` calls inside `operation` (such as
  /// `onTokensRefreshed`) execute re-entrantly without re-acquiring the lock.
  public static func withRefreshLock<T>(
    server: URL,
    _ operation: () async throws -> T
  ) async throws -> T {
    if heldLockServers.contains(server) {
      return try await operation()
    }
    let descriptor = try await acquireRefreshLock(server: server)
    defer { releaseRefreshLock(descriptor) }
    var held = heldLockServers
    held.insert(server)
    return try await $heldLockServers.withValue(held) {
      try await operation()
    }
  }

  private static func withAcquiredLockIfNeeded<T>(
    server: URL,
    _ operation: () throws -> T
  ) throws -> T {
    if heldLockServers.contains(server) {
      return try operation()
    }
    let descriptor = try acquireRefreshLockSync(server: server)
    defer { releaseRefreshLock(descriptor) }
    var held = heldLockServers
    held.insert(server)
    return try $heldLockServers.withValue(held) {
      try operation()
    }
  }

  static func acquireRefreshLock(server: URL) async throws -> Int32 {
    #if canImport(Darwin)
      let descriptor = try openRefreshLockDescriptor(server: server)
      var acquired = false
      defer {
        if !acquired { Darwin.close(descriptor) }
      }
      for _ in 0..<200 {
        if flock(descriptor, LOCK_EX | LOCK_NB) == 0 {
          acquired = true
          return descriptor
        }
        guard errno == EWOULDBLOCK else {
          throw AuthenticatedHTTPClient.AuthenticationError.temporarilyUnavailable
        }
        try await Task.sleep(nanoseconds: 50_000_000)
      }
      throw AuthenticatedHTTPClient.AuthenticationError.temporarilyUnavailable
    #else
      return -1
    #endif
  }

  static func acquireRefreshLockSync(server: URL) throws -> Int32 {
    #if canImport(Darwin)
      let descriptor = try openRefreshLockDescriptor(server: server)
      var acquired = false
      defer {
        if !acquired { Darwin.close(descriptor) }
      }
      for _ in 0..<200 {
        if flock(descriptor, LOCK_EX | LOCK_NB) == 0 {
          acquired = true
          return descriptor
        }
        guard errno == EWOULDBLOCK else {
          throw NSError(domain: "TokenStore", code: Int(errno))
        }
        usleep(50_000)
      }
      throw NSError(domain: "TokenStore", code: Int(EWOULDBLOCK))
    #else
      return -1
    #endif
  }

  /// Attempts to acquire the per-server refresh lock without sleeping and
  /// persist `tokens`. Returns `true` if the save completed immediately, or
  /// `false` when another refresh holds the lock (so a `@MainActor` caller can
  /// hand off to `saveAsync` without blocking the UI thread).
  public static func trySaveWithoutBlocking(
    _ tokens: AuthTokens,
    server: URL,
    generation: UInt64? = nil
  ) throws -> Bool {
    if heldLockServers.contains(server) {
      try saveUnlocked(tokens, server: server)
      return true
    }
    let targetGeneration = generation ?? reserveMutationGeneration(for: server)
    #if canImport(Darwin)
      let descriptor = try openRefreshLockDescriptor(server: server)
      guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
        let lockErrno = errno
        Darwin.close(descriptor)
        if lockErrno == EWOULDBLOCK { return false }
        throw NSError(domain: "TokenStore", code: Int(lockErrno))
      }
      defer { releaseRefreshLock(descriptor) }
      guard isCurrentMutationGeneration(targetGeneration, for: server) else { return true }
      var held = heldLockServers
      held.insert(server)
      try $heldLockServers.withValue(held) {
        try saveUnlocked(tokens, server: server)
      }
      return true
    #else
      guard isCurrentMutationGeneration(targetGeneration, for: server) else { return true }
      try saveUnlocked(tokens, server: server)
      return true
    #endif
  }

  /// Attempts to acquire the per-server refresh lock without sleeping and
  /// clear the Keychain item. Returns `true` if the clear completed
  /// immediately, or `false` when another refresh holds the lock (so a
  /// `@MainActor` caller can hand off to `clearAsync` without blocking the UI
  /// thread). If the lock file cannot be opened at all, clears immediately and
  /// returns `true`.
  public static func tryClearWithoutBlocking(server: URL, generation: UInt64? = nil) -> Bool {
    if heldLockServers.contains(server) {
      clearUnlocked(server: server)
      return true
    }
    let targetGeneration = generation ?? reserveMutationGeneration(for: server)
    #if canImport(Darwin)
      guard let descriptor = try? openRefreshLockDescriptor(server: server) else {
        if isCurrentMutationGeneration(targetGeneration, for: server) {
          clearUnlocked(server: server)
        }
        return true
      }
      guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
        let lockErrno = errno
        Darwin.close(descriptor)
        if lockErrno == EWOULDBLOCK { return false }
        if isCurrentMutationGeneration(targetGeneration, for: server) {
          clearUnlocked(server: server)
        }
        return true
      }
      defer { releaseRefreshLock(descriptor) }
      guard isCurrentMutationGeneration(targetGeneration, for: server) else { return true }
      var held = heldLockServers
      held.insert(server)
      $heldLockServers.withValue(held) {
        clearUnlocked(server: server)
      }
      return true
    #else
      if isCurrentMutationGeneration(targetGeneration, for: server) {
        clearUnlocked(server: server)
      }
      return true
    #endif
  }

  static func releaseRefreshLock(_ descriptor: Int32) {
    #if canImport(Darwin)
      guard descriptor >= 0 else { return }
      flock(descriptor, LOCK_UN)
      Darwin.close(descriptor)
    #endif
  }

  #if canImport(Darwin)
    private static func openRefreshLockDescriptor(server: URL) throws -> Int32 {
      #if os(tvOS) || os(watchOS)
        // tvOS runs no auth-capable extension processes (no File Provider,
        // no QuickLook) — this app is the only refresh actor, and the
        // in-process single-flight task already serializes concurrent
        // refreshes. The flock stays a real cross-process lock; with no
        // sibling process to coordinate, its FILE just doesn't need to live
        // in the shared App Group container. Gating tvOS refresh on that
        // container bricked auth on real Apple TV hardware: the container
        // lookup failed at runtime despite the granted entitlement, so no
        // refresh ever reached the server and every session died at
        // access-token expiry (#2380 — every tvOS refresh family in
        // production sat un-rotated). The app-private temporary directory
        // is always available. The Watch is likewise its session's only
        // refresh actor (#3617), and an app-private lock file is safe to hold
        // across suspension where an App Group one is not (#5022).
        let container = FileManager.default.temporaryDirectory
      #else
        // A test process gets the app-private temporary directory BEFORE the
        // shared container is even looked up (#2387). The lookup itself is a
        // synchronous, untimed XPC round-trip to `containermanagerd`, and the
        // flock that follows it is a REAL cross-process lock — so a unit test
        // that reached the shared container inherited the responsiveness of a
        // system daemon and the liveness of every other Maple process on the
        // developer's machine (an installed Maple.app, MapleBackupAgent, the
        // File Provider / QuickLook extensions), for up to the 10 s the retry
        // loop below spins. `RemoteCatalogDownloadAssetTests` proved this
        // concretely: `~/Library/Group Containers/group.app.justmaple.aperture/
        // AuthLocks/b061d8220ab2bfb0.lock` is `stableServerHash` of the test's
        // own `https://x.test`, written there by earlier test runs.
        //
        // This gate USED to sit after the container check, as the fallback for
        // "no container available," which meant it never fired on any machine
        // that had ever run Maple.app — exactly the machines that run the
        // tests. Order is the whole fix; the production branches below are
        // untouched (no shipping process links XCTest).
        let container: URL
        if NSClassFromString("XCTestCase") != nil {
          container = FileManager.default.temporaryDirectory
        } else if let sharedContainer = FileManager.default.containerURL(
          forSecurityApplicationGroupIdentifier: "group.app.justmaple.aperture"
        ) {
          container = sharedContainer
        } else {
          // iOS/macOS share refresh families with extension processes
          // (File Provider, QuickLook) — refusing to refresh without the
          // cross-process lock is deliberate: an uncoordinated rotation
          // there can strand a sibling process's token and revoke the
          // whole family (#1868 class). Do NOT weaken this branch.
          cloudHTTPLogger.fault("shared App Group container unavailable; refusing unsafe refresh")
          throw AuthenticatedHTTPClient.AuthenticationError.temporarilyUnavailable
        }
      #endif
      let directory = container.appendingPathComponent("AuthLocks", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let path = directory.appendingPathComponent("\(stableServerHash(server)).lock").path
      let descriptor = Darwin.open(path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
      guard descriptor >= 0 else {
        throw AuthenticatedHTTPClient.AuthenticationError.temporarilyUnavailable
      }
      return descriptor
    }

    static func stableServerHash(_ server: URL) -> String {
      var hash: UInt64 = 14_695_981_039_346_656_037
      for byte in server.absoluteString.utf8 {
        hash ^= UInt64(byte)
        hash &*= 1_099_511_628_211
      }
      return String(hash, radix: 16)
    }
  #endif
}
