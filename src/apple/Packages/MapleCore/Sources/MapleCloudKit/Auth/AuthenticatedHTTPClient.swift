// src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AuthenticatedHTTPClient.swift
import Foundation
import OSLog
#if canImport(Darwin)
import Darwin
#endif

/// Logger for the cloud HTTP layer. View live in Xcode's debug console
/// or via Console.app filtering on subsystem `app.justmaple.aperture.cloud`
/// category `http`. Verbose bodies are at `.debug` level so they're
/// visible in development but stripped from release archives.
public let cloudHTTPLogger = Logger(
  subsystem: "app.justmaple.aperture.cloud",
  category: "http"
)

public actor AuthenticatedHTTPClient {
  public enum AuthenticationError: Error, Equatable {
    case notAuthenticated
    case temporarilyUnavailable
  }
  private let server: URL
  private let urlSession: URLSession
  private let tokensProvider: () -> AuthTokens?
  private let onTokensRefreshed: (AuthTokens) throws -> Void
  private let onSignOut: () -> Void
  private var inflightRefresh: Task<AuthTokens, Error>?

  public init(server: URL, urlSession: URLSession,
              tokensProvider: @escaping () -> AuthTokens?,
              onTokensRefreshed: @escaping (AuthTokens) throws -> Void,
              onSignOut: @escaping () -> Void) {
    self.server = server; self.urlSession = urlSession
    self.tokensProvider = tokensProvider; self.onTokensRefreshed = onTokensRefreshed
    self.onSignOut = onSignOut
  }

  /// Sample client for SwiftUI `#Preview` blocks. Points at an unreachable
  /// example URL with a no-op token provider; any network call fails fast,
  /// which is the intended behaviour for previews. Issue #139.
  ///
  /// Uses an ephemeral `URLSession` with a 2-second request timeout so a
  /// preview that accidentally triggers a real request doesn't sit on
  /// `URLSession.shared`'s default 60-second timeout (which would freeze
  /// Xcode's preview canvas).
  public static func preview(
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> AuthenticatedHTTPClient {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 2
    config.timeoutIntervalForResource = 2
    return AuthenticatedHTTPClient(
      server: server,
      urlSession: URLSession(configuration: config),
      tokensProvider: { nil },
      onTokensRefreshed: { _ in },
      onSignOut: { }
    )
  }

  public func data(for request: URLRequest) async throws -> (Data, URLResponse) {
    Self.logRequest(request, attempt: 1)
    let tokens = try await requiredTokensForRequest()
    let (data, resp) = try await dataOnce(request: inject(request, tokens: tokens))
    Self.logResponse(resp, data: data, request: request)

    if (resp as? HTTPURLResponse)?.statusCode != 401 { return (data, resp) }

    cloudHTTPLogger.info("401 — attempting token refresh")
    guard let current = tokensProvider() else { onSignOut(); return (data, resp) }
    let fresh: AuthTokens
    do { fresh = try await refresh(refresh: current.refresh) }
    catch let e as URLError {
      // Transport-level failure during refresh — the user went offline
      // mid-flight. Surface the URLError to the caller so it can fall
      // back to its own cache instead of treating this as a sign-out.
      // Tokens stay in the Keychain; next time we have network we'll
      // try again.
      cloudHTTPLogger.error("token refresh network error: \(e.localizedDescription, privacy: .public)")
      throw e
    } catch let e as AuthClientError where e.isNetworkFailure {
      // Defensive: if refresh is ever routed through AuthClient (which
      // wraps URLError into AuthClientError.network) the URLError catch
      // above stops matching. Re-throw network failures here so we
      // don't silently sign the user out the moment that refactor lands.
      cloudHTTPLogger.error("token refresh network error: \(e.localizedDescription, privacy: .public)")
      throw e
    } catch RefreshFailure.terminal {
      cloudHTTPLogger.error("token refresh terminally rejected")
      onSignOut(); return (data, resp)
    } catch {
      cloudHTTPLogger.error("token refresh failed: \(error.localizedDescription, privacy: .public)")
      throw AuthenticationError.temporarilyUnavailable
    }
    Self.logRequest(request, attempt: 2)
    let retried = try await dataOnce(request: inject(request, tokens: fresh))
    Self.logResponse(retried.1, data: retried.0, request: request)
    return retried
  }

  /// Sentinel thrown by the refresh task when the refresh endpoint
  /// returns a non-200 response. We use a distinct error type from
  /// URLError so the caller can tell "refresh said no" (sign-out is
  /// correct) from "refresh couldn't reach the server" (keep tokens).
  private enum RefreshFailure: Error {
    case terminal
    case transient
  }

  /// Hits `/api/auth/refresh` directly through `urlSession`, NOT through
  /// `AuthClient` — by contract, transport failures here surface as a
  /// bare `URLError` (and only as a `URLError`), which the caller
  /// distinguishes from a server-side rejection (`RefreshRejected`) to
  /// decide whether to sign out. If you route this through `AuthClient`
  /// in the future, update the caller's catch ladder to handle
  /// `AuthClientError.network` as a transport failure too — there is
  /// already a defensive catch upstream so the change won't silently
  /// break, but the contract here is "URLError = transport."
  private func refresh(refresh refreshToken: String) async throws -> AuthTokens {
    // Persistence is inside the shared task, before the cross-process lock is
    // released. Every waiter therefore observes either one durably persisted
    // rotation or the same persistence error; none can use the new access token
    // early, and N concurrent 401s still produce exactly one Keychain write.
    if let t = inflightRefresh { return try await t.value }
    let task = Task { () throws -> AuthTokens in
      let lock = try await Self.acquireRefreshLock(server: server)
      defer { Self.releaseRefreshLock(lock) }
      // A different Apple process may have rotated while this process waited
      // for the App Group lock. Adopt that generation instead of replaying the
      // predecessor refresh token.
      var effectiveRefreshToken = refreshToken
      if let latest = tokensProvider(), latest.refresh != refreshToken {
        if !Self.accessTokenIsExpired(latest.access, skew: 0) {
          return latest
        }
        // The other process rotated long enough ago that its access token is
        // already expired too. Refresh from that newer generation, never the
        // predecessor this process originally read.
        effectiveRefreshToken = latest.refresh
      }
      var req = URLRequest(url: server.appending(path: "/api/auth/refresh"))
      req.httpMethod = "POST"
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try JSONSerialization.data(withJSONObject: ["refresh_token": effectiveRefreshToken])
      let (data, resp) = try await urlSession.data(for: req)
      guard let http = resp as? HTTPURLResponse else { throw RefreshFailure.transient }
      if http.statusCode == 401 { throw RefreshFailure.terminal }
      guard http.statusCode == 200 else { throw RefreshFailure.transient }
      // The rotated refresh token rides the JSON body for native (Keychain)
      // clients — we have no cookie jar. `refresh_token` is decoded as optional
      // purely as a safety net: a server that ever omits it (e.g. legacy
      // cookie-only rotation) must not make the decode throw and escalate into a
      // sign-out. When absent we keep the token we presented.
      struct R: Decodable { let access_token: String; let refresh_token: String? }
      let r = try JSONDecoder().decode(R.self, from: data)
      let tokens = AuthTokens(
        access: r.access_token,
        refresh: r.refresh_token ?? effectiveRefreshToken
      )
      // Rotation consumes the old refresh token server-side. Do not expose the
      // replacement or release the refresh lock until it is durably persisted;
      // otherwise this launch appears healthy while the next launch replays the
      // dead predecessor and forces the user to pair again.
      try onTokensRefreshed(tokens)
      return tokens
    }
    inflightRefresh = task
    defer { inflightRefresh = nil }
    return try await task.value
  }

  /// Returns a copy of `req` with the current access token injected as a
  /// Bearer Authorization header. Public so callers that bypass `data(for:)`
  /// — notably `URLSession.download(for:)` paths — can still authenticate.
  /// Proactively refreshes an already-expired token first (see
  /// `tokensForRequest`), so a token snapshot handed to a caller that can't
  /// retry-on-401 is still live.
  public func inject(_ req: URLRequest) async throws -> URLRequest {
    inject(req, tokens: try await requiredTokensForRequest())
  }

  /// Seconds of clock skew: refresh proactively when the access token is within
  /// this window of (or already past) its `exp`, so we don't dispatch a request
  /// we already know the server will 401. The reactive 401 path below remains
  /// the safety net for tokens the server rejects early.
  private static let proactiveRefreshSkew: TimeInterval = 60

  /// The freshest tokens to sign the next request with. If the current access
  /// token is expired (within skew), refresh once — single-flight — and persist
  /// the rotation before returning it. Any refresh failure falls back to the
  /// current tokens: a transient proactive-refresh failure must never block the
  /// request or sign the user out; the reactive 401 handler covers that case.
  private func tokensForRequest() async -> AuthTokens? {
    guard let current = tokensProvider() else { return nil }
    guard Self.accessTokenIsExpired(current.access, skew: Self.proactiveRefreshSkew) else {
      return current
    }
    cloudHTTPLogger.info("access token within expiry skew — proactive refresh")
    guard let fresh = try? await refresh(refresh: current.refresh) else { return current }
    return fresh
  }

  private func requiredTokensForRequest() async throws -> AuthTokens {
    guard let current = tokensProvider() else {
      throw AuthenticationError.notAuthenticated
    }
    guard Self.accessTokenIsExpired(current.access, skew: Self.proactiveRefreshSkew) else {
      return current
    }
    do {
      return try await refresh(refresh: current.refresh)
    } catch let error as URLError {
      cloudHTTPLogger.error("proactive refresh unavailable: \(error.localizedDescription, privacy: .public)")
      throw AuthenticationError.temporarilyUnavailable
    } catch RefreshFailure.terminal {
      onSignOut()
      throw AuthenticationError.notAuthenticated
    } catch {
      cloudHTTPLogger.error("proactive refresh rejected: \(error.localizedDescription, privacy: .public)")
      throw AuthenticationError.temporarilyUnavailable
    }
  }

  /// A fresh access token for transports such as AVPlayer that cannot attach
  /// the client's Authorization header to their range requests.
  public func accessTokenForURL() async throws -> String {
    (try await requiredTokensForRequest()).access
  }

  private static func acquireRefreshLock(server: URL) async throws -> Int32 {
    #if canImport(Darwin)
    #if os(tvOS)
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
    // is always available.
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
      throw AuthenticationError.temporarilyUnavailable
    }
    #endif
    let directory = container.appendingPathComponent("AuthLocks", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let path = directory.appendingPathComponent("\(stableServerHash(server)).lock").path
    let descriptor = Darwin.open(path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw AuthenticationError.temporarilyUnavailable }
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
        throw AuthenticationError.temporarilyUnavailable
      }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    throw AuthenticationError.temporarilyUnavailable
    #else
    return -1
    #endif
  }

  private static func releaseRefreshLock(_ descriptor: Int32) {
    #if canImport(Darwin)
    guard descriptor >= 0 else { return }
    flock(descriptor, LOCK_UN)
    Darwin.close(descriptor)
    #endif
  }

  private static func stableServerHash(_ server: URL) -> String {
    var hash: UInt64 = 14_695_981_039_346_656_037
    for byte in server.absoluteString.utf8 {
      hash ^= UInt64(byte)
      hash &*= 1_099_511_628_211
    }
    return String(hash, radix: 16)
  }

  /// True when the JWT's `exp` claim is within `skew` seconds of now (or past).
  /// Returns false for any token whose payload can't be parsed for a numeric
  /// `exp` — an opaque/legacy token is left to the reactive 401 path rather than
  /// eagerly refreshed. Signature is NOT verified (the client holds no secret);
  /// `exp` is advisory scheduling only, and the server re-validates every token.
  static func accessTokenIsExpired(_ jwt: String, skew: TimeInterval) -> Bool {
    let parts = jwt.split(separator: ".")
    guard parts.count >= 2,
          let payload = base64URLDecode(String(parts[1])),
          let obj = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
          let exp = (obj["exp"] as? NSNumber)?.doubleValue
    else { return false }
    return Date().timeIntervalSince1970 + skew >= exp
  }

  private static func base64URLDecode(_ s: String) -> Data? {
    var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    let remainder = b.count % 4
    if remainder != 0 { b += String(repeating: "=", count: 4 - remainder) }
    return Data(base64Encoded: b)
  }

  private func inject(_ req: URLRequest, tokens: AuthTokens?) -> URLRequest {
    var r = req
    if let t = tokens { r.setValue("Bearer \(t.access)", forHTTPHeaderField: "Authorization") }
    return r
  }

  /// Run `block` once with an authenticated request. If the response is
  /// 401, refresh tokens (single-flight) and retry the block once with a
  /// freshly-authenticated request. Used by code paths that can't go
  /// through `data(for:)` because they need a non-buffered transport
  /// (`URLSession.download(for:)`).
  ///
  /// `block` receives the injected request and must return its response;
  /// the generic `T` is whatever payload kind the caller's transport
  /// yields (`Data` for `URLSession.data`, `URL` for `URLSession.download`).
  public func refreshIfNeededAndRetry<T>(
    request: URLRequest,
    _ block: (URLRequest) async throws -> (T, URLResponse)
  ) async throws -> (T, URLResponse) {
    Self.logRequest(request, attempt: 1)
    var injected = inject(request, tokens: try await requiredTokensForRequest())
    var (payload, resp) = try await block(injected)
    if (resp as? HTTPURLResponse)?.statusCode != 401 { return (payload, resp) }

    cloudHTTPLogger.info("401 — attempting token refresh (download path)")
    guard let current = tokensProvider() else { onSignOut(); return (payload, resp) }
    let fresh: AuthTokens
    do { fresh = try await refresh(refresh: current.refresh) }
    catch let e as URLError {
      cloudHTTPLogger.error("token refresh network error: \(e.localizedDescription, privacy: .public)")
      throw e
    } catch let e as AuthClientError where e.isNetworkFailure {
      cloudHTTPLogger.error("token refresh network error: \(e.localizedDescription, privacy: .public)")
      throw e
    } catch RefreshFailure.terminal {
      cloudHTTPLogger.error("token refresh terminally rejected")
      onSignOut(); return (payload, resp)
    } catch {
      cloudHTTPLogger.error("token refresh failed: \(error.localizedDescription, privacy: .public)")
      throw AuthenticationError.temporarilyUnavailable
    }
    Self.logRequest(request, attempt: 2)
    injected = inject(request, tokens: fresh)
    (payload, resp) = try await block(injected)
    return (payload, resp)
  }

  private func dataOnce(request: URLRequest) async throws -> (Data, URLResponse) {
    try await urlSession.data(for: request)
  }

  /// Streaming upload variant. Same refresh-on-401 contract as `data(for:)`
  /// but routes through `URLSession.upload(for:fromFile:)` so the request
  /// body never has to be loaded into memory. Used by the File Provider
  /// extension's drag-in upload path.
  public func upload(for request: URLRequest, fromFile fileURL: URL) async throws -> (Data, URLResponse) {
    Self.logRequest(request, attempt: 1)
    let signed = inject(request, tokens: try await requiredTokensForRequest())
    let (data, resp) = try await urlSession.upload(for: signed, fromFile: fileURL)
    Self.logResponse(resp, data: data, request: request)

    if (resp as? HTTPURLResponse)?.statusCode != 401 { return (data, resp) }

    cloudHTTPLogger.info("401 — attempting token refresh (upload)")
    guard let current = tokensProvider() else { onSignOut(); return (data, resp) }
    let fresh: AuthTokens
    do { fresh = try await refresh(refresh: current.refresh) }
    catch let e as URLError {
      cloudHTTPLogger.error("token refresh network error: \(e.localizedDescription, privacy: .public)")
      throw e
    } catch let e as AuthClientError where e.isNetworkFailure {
      cloudHTTPLogger.error("token refresh network error: \(e.localizedDescription, privacy: .public)")
      throw e
    } catch RefreshFailure.terminal {
      cloudHTTPLogger.error("token refresh terminally rejected")
      onSignOut(); return (data, resp)
    } catch {
      cloudHTTPLogger.error("token refresh failed: \(error.localizedDescription, privacy: .public)")
      throw AuthenticationError.temporarilyUnavailable
    }
    Self.logRequest(request, attempt: 2)
    let retried = try await urlSession.upload(for: inject(request, tokens: fresh), fromFile: fileURL)
    Self.logResponse(retried.1, data: retried.0, request: request)
    return retried
  }

  // MARK: - Logging helpers

  /// URL paths and query parameters can carry user data (filenames, ids).
  /// We log them at `.public` because debugging a multi-tenant cloud
  /// without seeing the actual URL is impractical. Bodies are NOT logged
  /// (could contain tokens) except for the response body's first 512
  /// bytes, which is enough to diagnose decode failures and short error
  /// payloads but truncates auth responses before tokens leak.
  private static func logRequest(_ req: URLRequest, attempt: Int) {
    let method = req.httpMethod ?? "GET"
    let url = req.url?.absoluteString ?? "<no-url>"
    let attemptNote = attempt > 1 ? " (retry #\(attempt))" : ""
    cloudHTTPLogger.debug("→ \(method, privacy: .public) \(url, privacy: .public)\(attemptNote, privacy: .public)")
  }

  private static func logResponse(_ resp: URLResponse, data: Data, request req: URLRequest) {
    let url = req.url?.absoluteString ?? "<no-url>"
    let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
    let bytes = data.count
    cloudHTTPLogger.debug("← \(status, privacy: .public) \(bytes, privacy: .public)B  \(url, privacy: .public)")

    // Log the body preview ONLY for 4xx/5xx (error payloads, usually JSON
    // error messages) and for plausibly-textual successful responses
    // small enough to be a JSON document, not a thumbnail. Skips
    // /api/auth/* responses entirely so access/refresh tokens never reach
    // the log.
    let isAuthEndpoint = url.contains("/api/auth/")
    let isError = !(200..<300).contains(status)
    let isSmallText = bytes > 0 && bytes < 8192
    let contentType = (resp as? HTTPURLResponse)?
      .value(forHTTPHeaderField: "Content-Type") ?? ""
    let looksTextual = contentType.contains("json")
                     || contentType.contains("text")
                     || contentType.isEmpty

    if !isAuthEndpoint && (isError || (isSmallText && looksTextual)) {
      let preview = String(data: data.prefix(512), encoding: .utf8) ?? "<non-utf8 \(bytes)B>"
      cloudHTTPLogger.debug("← body: \(preview, privacy: .public)")
    }
  }
}
