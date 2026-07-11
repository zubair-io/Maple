// LocalNetworkResolver.swift
//
// Prefers a self-hosted server's LAN address over the public URL it was
// registered under (the "identity" URL — the one CloudServerRegistry stores
// and TokenStore keys the Keychain on), when the client is actually on the
// same network as the server.
//
// `AuthenticatedHTTPClient`/`AuthClient` only ever use their `server` field
// to build the token-refresh request and to key `TokenStore` lookups — never
// to build the URL for a data request (each per-feature client takes its own
// `server`/`baseURL` param for that; see `CloudHistogramClient`,
// `CloudSource`, etc.). So the LAN address can be substituted purely at the
// point where those per-feature clients are constructed, passing the
// resolved (possibly-LAN) URL into their `server`/`baseURL` param while
// `makeAuthenticatedHTTPClient`/`makeBackupTransport` keep using the
// identity URL. See `AppShell+CloudActions.swift`, `ChangeObserverWiring.swift`,
// and `EngineHost.swift` for the call sites this backs.
//
// Requires the `NSAllowsLocalNetworking` ATS exception (Maple-Info.plist) —
// without it every probe/request below fails at the network layer, which is
// swallowed safely here (the feature just never activates, never crashes).

import Foundation

/// Wire shape returned by the public `GET /api/network/local-address`.
public struct LocalAddressReport: Decodable, Sendable {
  public let available: Bool
  public let ip: String?
  public let port: Int?
  public let scheme: String?
}

/// The latest LAN discovery result for a registered server.
public struct LocalNetworkStatus: Equatable, Sendable {
  public let localURL: URL?
  public let isConnectedLocally: Bool
}

/// Stateless, process-independent resolution logic — no caching, no actor
/// isolation, callable from the main app AND `MapleBackupAgent` (a separate
/// process with no access to the foreground app's in-memory cache).
public enum LocalNetworkResolving {
  /// Fetches the LAN-address report from `identity`, reachability-probes
  /// the candidate with a short timeout, and returns the candidate URL on
  /// success. Returns `identity` unchanged on any failure — a bad report, an
  /// unreachable candidate, a missing ATS exception, being on a different
  /// network — all fall back the same way. Never throws.
  public static func resolveEffectiveURL(
    identity: URL,
    probeTimeout: TimeInterval = 1.5,
    session: URLSession = .shared
  ) async -> URL {
    await resolveStatus(identity: identity, probeTimeout: probeTimeout, session: session).effectiveURL
  }

  static func resolveStatus(
    identity: URL,
    probeTimeout: TimeInterval = 1.5,
    session: URLSession = .shared
  ) async -> (effectiveURL: URL, status: LocalNetworkStatus) {
    guard let report = await fetchReport(url: identity.appending(path: "/api/network/local-address"), session: session),
          report.available,
          let ip = report.ip,
          let port = report.port,
          let candidate = URL(string: "\(report.scheme ?? "http")://\(ip):\(port)")
    else {
      return (identity, LocalNetworkStatus(localURL: nil, isConnectedLocally: false))
    }
    // Reachability probe: re-hit the SAME report endpoint, but at the
    // candidate origin, and require it to answer with a matching
    // `available`/ip/port — not just any 200. Per-feature clients attach a
    // Bearer token to every subsequent data request, so a probe that only
    // checked "is something listening on ip:port" would risk sending
    // credentials to an unrelated host if the reported IP were stale or
    // later reassigned to a different device on the LAN.
    guard let confirmed = await fetchReport(
      url: candidate.appending(path: "/api/network/local-address"),
      session: session,
      timeout: probeTimeout
    ),
      confirmed.available,
      confirmed.ip == ip,
      confirmed.port == port
    else {
      return (identity, LocalNetworkStatus(localURL: candidate, isConnectedLocally: false))
    }
    return (candidate, LocalNetworkStatus(localURL: candidate, isConnectedLocally: true))
  }

  private static func fetchReport(
    url: URL, session: URLSession, timeout: TimeInterval = 3
  ) async -> LocalAddressReport? {
    var req = URLRequest(url: url)
    req.timeoutInterval = timeout
    guard let (data, resp) = try? await session.data(for: req),
          (resp as? HTTPURLResponse)?.statusCode == 200
    else { return nil }
    return try? JSONDecoder().decode(LocalAddressReport.self, from: data)
  }
}

/// App-facing cache: `@MainActor`/`@Observable` so the sidebar/session layer
/// can read a synchronous "best known effective URL" without awaiting a
/// probe on every client construction. Populated once per registered server
/// at app launch (see `MapleApp.session(for:)`).
@MainActor
@Observable
public final class LocalNetworkResolver {
  public static let shared = LocalNetworkResolver()

  private var resolved: [String: URL] = [:]
  private var statuses: [String: LocalNetworkStatus] = [:]

  public init() {}

  /// The best known URL to use for `identity` — the resolved LAN address if
  /// `resolve(identity:)` has completed and found one reachable, otherwise
  /// `identity` itself (including before any `resolve()` call has run).
  public func effectiveURL(for identity: URL) -> URL {
    resolved[identity.absoluteString] ?? identity
  }

  /// Latest discovery state, or nil while this server has not yet been checked.
  public func status(for identity: URL) -> LocalNetworkStatus? {
    statuses[identity.absoluteString]
  }

  /// Runs the resolution for `identity` and caches the result. Safe to call
  /// repeatedly (e.g. on every app launch) — each call re-probes fresh.
  /// `session` defaults to `.shared`; tests inject a stubbed session.
  public func resolve(identity: URL, session: URLSession = .shared) async {
    let result = await LocalNetworkResolving.resolveStatus(identity: identity, session: session)
    resolved[identity.absoluteString] = result.effectiveURL
    statuses[identity.absoluteString] = result.status
  }
}
