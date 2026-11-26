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
  public let https: LocalHttpsEndpoint?

  fileprivate var candidates: [LocalHttpsEndpoint] {
    guard available else { return [] }
    let legacy = ip.flatMap { host in
      port.map { LocalHttpsEndpoint(ip: host, port: $0, scheme: scheme ?? "http") }
    }
    return [https.flatMap { $0.scheme == "https" ? $0 : nil }, legacy].compactMap { $0 }
  }
}

public struct LocalHttpsEndpoint: Decodable, Sendable, Equatable {
  public let ip: String
  public let port: Int
  public let scheme: String

  fileprivate var url: URL? {
    guard ["https", "http"].contains(scheme), (1...65535).contains(port),
      !ip.isEmpty, !ip.contains(where: { $0.isWhitespace }),
      !ip.contains(where: { "/@?#".contains($0) })
    else { return nil }
    var components = URLComponents()
    components.scheme = scheme
    components.host = ip
    components.port = port
    return components.url
  }
}

/// The latest LAN discovery result for a registered server.
public struct LocalNetworkStatus: Equatable, Sendable {
  public let localURL: URL?
  public let isConnectedLocally: Bool

  public init(localURL: URL?, isConnectedLocally: Bool) {
    self.localURL = localURL
    self.isConnectedLocally = isConnectedLocally
  }
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
    await resolveStatus(identity: identity, probeTimeout: probeTimeout, session: session)
      .effectiveURL
  }

  typealias CandidateProbe = @Sendable (LocalHttpsEndpoint) async -> Bool

  static func resolveStatus(
    identity: URL,
    probeTimeout: TimeInterval = 1.5,
    session: URLSession = .shared,
    probe: CandidateProbe? = nil
  ) async -> (effectiveURL: URL, status: LocalNetworkStatus) {
    guard
      let report = await fetchReport(
        url: identity.appending(path: "/api/network/local-address"), session: session)
    else { return (identity, LocalNetworkStatus(localURL: nil, isConnectedLocally: false)) }
    // The echo probe below only proves that SOMETHING at the advertised
    // address speaks Maple's report shape, which any host on a hostile
    // network can fake. For an HTTPS identity the only acceptable LAN proof
    // is a TLS-validated endpoint, so a cleartext candidate is never used —
    // the bearer and photo bytes stay under TLS (#4720). An HTTP identity
    // has nothing to downgrade from and keeps the legacy ip:port path.
    let identityIsHTTPS = identity.scheme?.lowercased() == "https"
    let candidates = report.candidates.filter {
      !identityIsHTTPS || $0.scheme.lowercased() == "https"
    }
    // Hostname TLS is validated normally by URLSession; a hostname's
    // certificate is never reused or trusted for the IP fallback.
    let probeCandidate: CandidateProbe =
      probe ?? { endpoint in
        guard let candidate = endpoint.url,
          let confirmed = await fetchReport(
            url: candidate.appending(path: "/api/network/local-address"), session: session,
            timeout: probeTimeout)
        else { return false }
        return confirmed.candidates.contains(endpoint)
      }
    guard
      let winner = await firstPreferredSuccess(of: candidates, probe: probeCandidate),
      let url = winner.url
    else {
      return (
        identity, LocalNetworkStatus(localURL: candidates.first?.url, isConnectedLocally: false)
      )
    }
    return (url, LocalNetworkStatus(localURL: url, isConnectedLocally: true))
  }

  // Preference order wins even when a later candidate answers sooner, so the
  // chosen route is the one a probe-one-then-the-next loop would pick.
  static func firstPreferredSuccess(
    of endpoints: [LocalHttpsEndpoint], probe: @escaping CandidateProbe
  ) async -> LocalHttpsEndpoint? {
    let attempts = endpoints.map { endpoint in Task { await probe(endpoint) } }
    return await withTaskCancellationHandler {
      for (endpoint, attempt) in zip(endpoints, attempts) where await attempt.value {
        for other in attempts { other.cancel() }
        return endpoint
      }
      return nil
    } onCancel: {
      for attempt in attempts { attempt.cancel() }
    }
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
  private var probes: [String: Task<Void, Never>] = [:]

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

  /// Like ``effectiveURL(for:)``, but first waits up to `limit` for a probe
  /// of `identity` that is already running, so a folder opened while the
  /// launch probe is still in flight gets the LAN address instead of keeping
  /// the public one for its whole life (#6008). Bounded because a probe away
  /// from home can take seconds to time out on a private LAN address, and a
  /// folder open must not stall on it. Never starts a probe of its own.
  public func settledEffectiveURL(
    for identity: URL, waitingAtMost limit: Duration = .milliseconds(500)
  ) async -> URL {
    if let probe = probes[identity.absoluteString] {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let firstFinisher = ResumeOnce(continuation)
        let deadline = Task {
          try? await Task.sleep(for: limit)
          firstFinisher.resume()
        }
        Task {
          await probe.value
          deadline.cancel()
          firstFinisher.resume()
        }
      }
    }
    return effectiveURL(for: identity)
  }

  /// Runs the resolution for `identity` and caches the result. Safe to call
  /// repeatedly (e.g. on every app launch or foreground): a call made while
  /// a probe of the same server is running joins it rather than starting a
  /// second one. `session` defaults to `.shared`; tests inject a stubbed one.
  public func resolve(identity: URL, session: URLSession = .shared) async {
    let key = identity.absoluteString
    if let running = probes[key] {
      await running.value
      return
    }
    let probe = Task {
      let result = await LocalNetworkResolving.resolveStatus(identity: identity, session: session)
      resolved[key] = result.effectiveURL
      statuses[key] = result.status
    }
    probes[key] = probe
    await probe.value
    probes[key] = nil
  }
}

/// Resumes its continuation for whichever caller gets there first, so a race
/// between a probe and its deadline resumes exactly once.
@MainActor
private final class ResumeOnce {
  private var continuation: CheckedContinuation<Void, Never>?

  init(_ continuation: CheckedContinuation<Void, Never>) {
    self.continuation = continuation
  }

  func resume() {
    continuation?.resume()
    continuation = nil
  }
}
