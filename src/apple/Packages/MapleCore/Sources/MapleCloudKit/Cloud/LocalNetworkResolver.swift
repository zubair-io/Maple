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
    let secure = https.flatMap { $0.scheme.lowercased() == "https" ? $0 : nil }
    return [secure, legacy].compactMap { $0 }
  }
}

public struct LocalHttpsEndpoint: Decodable, Sendable, Equatable {
  public let ip: String
  public let port: Int
  public let scheme: String

  fileprivate func matches(_ other: LocalHttpsEndpoint) -> Bool {
    port == other.port && scheme.lowercased() == other.scheme.lowercased()
      && Self.bareHost(ip) == Self.bareHost(other.ip)
  }

  private static func bareHost(_ host: String) -> String {
    host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
  }

  fileprivate var url: URL? {
    guard ["https", "http"].contains(scheme.lowercased()), (1...65535).contains(port),
      !ip.isEmpty, !ip.contains(where: { $0.isWhitespace }),
      !ip.contains(where: { "/@?#".contains($0) })
    else { return nil }
    var components = URLComponents()
    components.scheme = scheme
    let bare = Self.bareHost(ip)
    components.host = bare.contains(":") ? "[\(bare)]" : ip
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
    // A hostname's TLS validation is never reused for the IP fallback.
    let probeCandidate: CandidateProbe =
      probe ?? { endpoint in
        await confirm(endpoint, session: session, timeout: probeTimeout)
      }
    guard
      let winner = await firstAnsweringCandidate(of: candidates, probe: probeCandidate),
      let url = winner.url
    else {
      return (
        identity, LocalNetworkStatus(localURL: candidates.first?.url, isConnectedLocally: false)
      )
    }
    return (url, LocalNetworkStatus(localURL: url, isConnectedLocally: true))
  }

  /// Applies a fresh resolution's candidate check to `route`, to keep a working route without resolving.
  static func confirmRoute(
    _ route: URL, probeTimeout: TimeInterval = 1.5, session: URLSession = .shared
  ) async -> Bool {
    guard let scheme = route.scheme, let host = route.host, let port = route.port else {
      return false
    }
    return await confirm(
      LocalHttpsEndpoint(ip: host, port: port, scheme: scheme), session: session,
      timeout: probeTimeout)
  }

  private static func confirm(
    _ endpoint: LocalHttpsEndpoint, session: URLSession, timeout: TimeInterval
  ) async -> Bool {
    guard let candidate = endpoint.url,
      let confirmed = await fetchReport(
        url: candidate.appending(path: "/api/network/local-address"), session: session,
        timeout: timeout)
    else { return false }
    return confirmed.candidates.contains { $0.matches(endpoint) }
  }

  // Strictly in order: probing the legacy address while the hostname answers could raise the Local Network prompt for nothing.
  static func firstAnsweringCandidate(
    of endpoints: [LocalHttpsEndpoint], probe: CandidateProbe
  ) async -> LocalHttpsEndpoint? {
    for endpoint in endpoints {
      guard !Task.isCancelled else { return nil }
      if await probe(endpoint) { return endpoint }
    }
    return nil
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
  typealias StatusProvider =
    @Sendable (URL, URLSession) async -> (effectiveURL: URL, status: LocalNetworkStatus)
  typealias RouteConfirmer = @Sendable (URL, URLSession) async -> Bool
  typealias Sleeper = @Sendable (Duration) async throws -> Void

  public static let shared = LocalNetworkResolver(
    pathChanges: AppActivity.trackedPathChanges,
    activityChanges: AppActivity.trackedChanges,
    initiallyActive: AppActivity.initiallyActive)

  private var resolved: [String: URL] = [:]
  private var statuses: [String: LocalNetworkStatus] = [:]
  private var probes: [String: Task<Void, Never>] = [:]
  private var waiters: [String: [ProbeWaiter]] = [:]
  private var knownServers: [String: (identity: URL, session: URLSession)] = [:]
  private var everRegistered: Set<String> = []
  private var eventCounter = 0
  private var probeStartedAt: [String: Int] = [:]
  private var recheckKeys: Set<String> = []
  private var lastPathChange = 0
  private(set) var reprobeDue = false
  private var isAppActive: Bool
  private var pathObserver: Task<Void, Never>?
  private var activityObserver: Task<Void, Never>?
  private var pendingPathReprobe: Task<Void, Never>?

  private let statusProvider: StatusProvider
  private let routeConfirmer: RouteConfirmer
  private let pathChanges: (@Sendable () -> AsyncStream<Void>)?
  private let activityChanges: (@Sendable () -> AsyncStream<Bool>)?
  private let registeredServers: @MainActor @Sendable () -> [URL]
  private let pathDebounce: Duration
  private let probeBound: Duration
  // One probe plus the replacement a path change starts.
  private var resolveWaitCap: Duration { probeBound * 2 }
  private let sleeper: Sleeper

  public convenience init() {
    self.init(pathChanges: nil)
  }

  init(
    statusProvider: @escaping StatusProvider = { identity, session in
      await LocalNetworkResolving.resolveStatus(identity: identity, session: session)
    },
    routeConfirmer: @escaping RouteConfirmer = { route, session in
      await LocalNetworkResolving.confirmRoute(route, session: session)
    },
    pathChanges: (@Sendable () -> AsyncStream<Void>)?,
    activityChanges: (@Sendable () -> AsyncStream<Bool>)? = nil,
    initiallyActive: Bool = true,
    registeredServers: @escaping @MainActor @Sendable () -> [URL] = {
      CloudServerRegistry.shared.servers
    },
    pathDebounce: Duration = .seconds(1),
    probeBound: Duration = .seconds(5),
    sleeper: @escaping Sleeper = { try await Task.sleep(for: $0) }
  ) {
    self.statusProvider = statusProvider
    self.routeConfirmer = routeConfirmer
    self.pathChanges = pathChanges
    self.activityChanges = activityChanges
    self.isAppActive = initiallyActive
    self.registeredServers = registeredServers
    self.pathDebounce = pathDebounce
    self.probeBound = probeBound
    self.sleeper = sleeper
    observeActivity()
  }

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

  /// Like ``effectiveURL(for:)``, but first waits up to `limit` for a running probe (#6008); never starts one.
  public func settledEffectiveURL(
    for identity: URL, waitingAtMost limit: Duration = .milliseconds(500)
  ) async -> URL {
    await awaitNewestProbe(identity.absoluteString, upTo: limit)
    return effectiveURL(for: identity)
  }

  /// Runs the resolution for `identity` and caches the result. Safe to call
  /// repeatedly (e.g. on every app launch or foreground): a call made while
  /// a probe of the same server is running joins it rather than starting a
  /// second one. `session` defaults to `.shared`; tests inject a stubbed one.
  public func resolve(identity: URL, session: URLSession = .shared) async {
    let key = identity.absoluteString
    knownServers[key] = (identity, session)
    if registeredIdentities().contains(Self.normalizedIdentity(identity)) {
      everRegistered.insert(Self.normalizedIdentity(identity))
    }
    observeIfNeeded()
    if probes[key] == nil {
      startProbe(identity: identity, session: session)
    } else {
      recheckKeys.remove(key)
    }
    await awaitNewestProbe(key, upTo: resolveWaitCap)
  }

  private func startProbe(identity: URL, session: URLSession, isRecheck: Bool = false) {
    let key = identity.absoluteString
    eventCounter += 1
    let generation = eventCounter
    probeStartedAt[key] = generation
    if isRecheck { recheckKeys.insert(key) } else { recheckKeys.remove(key) }
    probes[key]?.cancel()
    let provider = statusProvider
    let confirmer = routeConfirmer
    let workingRoute = statuses[key]?.isConnectedLocally == true ? resolved[key] : nil
    probes[key] = Task {
      // A route that still answers is kept: nothing resolves or publishes until it is proven dead.
      let routeStillAnswers: Bool
      if let workingRoute {
        routeStillAnswers = await confirmer(workingRoute, session)
      } else {
        routeStillAnswers = false
      }
      guard isNewestProbe(key, generation) else { return }
      let result = routeStillAnswers ? nil : await provider(identity, session)
      // A cancelled probe can still finish; it must not overwrite the newer one.
      guard isNewestProbe(key, generation) else { return }
      if let result { publish(result, for: key) }
      probes[key] = nil
      recheckKeys.remove(key)
      for waiter in waiters.removeValue(forKey: key) ?? [] { waiter.resume() }
    }
  }

  private func registeredIdentities() -> Set<String> {
    Set(registeredServers().map(Self.normalizedIdentity))
  }

  private static func normalizedIdentity(_ url: URL) -> String {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return url.absoluteString.lowercased()
    }
    let path = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
    let port = components.port.map { ":\($0)" } ?? ""
    let scheme = components.scheme?.lowercased() ?? ""
    let host = components.host?.lowercased() ?? ""
    return "\(scheme)://\(host)\(port)\(path)"
  }

  private func isNewestProbe(_ key: String, _ generation: Int) -> Bool {
    probeStartedAt[key] == generation && generation > lastPathChange
  }

  private func publish(
    _ result: (effectiveURL: URL, status: LocalNetworkStatus), for key: String
  ) {
    if resolved[key] != result.effectiveURL { resolved[key] = result.effectiveURL }
    if statuses[key] != result.status { statuses[key] = result.status }
  }

  /// Giving up after `limit` leaves the cached route and status untouched.
  private func awaitNewestProbe(_ key: String, upTo limit: Duration) async {
    guard probes[key] != nil || (reprobeDue && knownServers[key] != nil) else { return }
    let sleep = sleeper
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let waiter = ProbeWaiter(continuation)
      waiters[key, default: []].append(waiter)
      waiter.deadline = Task {
        guard (try? await sleep(limit)) != nil, !Task.isCancelled, waiter.isPending else { return }
        waiters[key]?.removeAll { $0 === waiter }
        waiter.resume()
      }
    }
  }

  private func observeIfNeeded() {
    guard pathObserver == nil, let pathChanges else { return }
    let changes = pathChanges()
    pathObserver = Task {
      for await _ in changes { networkPathChanged() }
    }
  }

  // From creation: an activation posted before the first resolve() would leave a cold launch inactive.
  private func observeActivity() {
    guard let activityChanges else { return }
    let changes = activityChanges()
    activityObserver = Task { [weak self] in
      for await isActive in changes { self?.appActivityChanged(isActive) }
    }
  }

  func networkPathChanged() {
    eventCounter += 1
    lastPathChange = eventCounter
    reprobeDue = true
    for probe in probes.values { probe.cancel() }
    probes.removeAll()
    recheckKeys.removeAll()
    pendingPathReprobe?.cancel()
    guard isAppActive else { return }
    let wait = pathDebounce
    let sleep = sleeper
    pendingPathReprobe = Task {
      guard (try? await sleep(wait)) != nil, !Task.isCancelled else { return }
      reprobeIfDue()
    }
  }

  func appActivityChanged(_ isActive: Bool) {
    isAppActive = isActive
    if isActive {
      reprobeIfDue()
    } else {
      pendingPathReprobe?.cancel()
      deferRunningRechecks()
    }
  }

  // A re-check still running in the background could go on to probe the LAN address with nothing on screen.
  private func deferRunningRechecks() {
    for key in recheckKeys {
      probes.removeValue(forKey: key)?.cancel()
      probeStartedAt[key] = nil
      reprobeDue = true
      for waiter in waiters.removeValue(forKey: key) ?? [] { waiter.resume() }
    }
    recheckKeys.removeAll()
  }

  // Probing while inactive can raise the Local Network prompt with nothing on screen, so a change then only marks a re-probe due.
  private func reprobeIfDue() {
    guard reprobeDue, isAppActive else { return }
    reprobeDue = false
    let registered = registeredIdentities()
    let removed = knownServers.keys.filter {
      let identity = Self.normalizedIdentity(knownServers[$0]!.identity)
      return everRegistered.contains(identity) && !registered.contains(identity)
    }
    everRegistered.formUnion(registered)
    everRegistered.subtract(removed.map { Self.normalizedIdentity(knownServers[$0]!.identity) })
    for key in removed {
      knownServers[key] = nil
      resolved[key] = nil
      statuses[key] = nil
      probeStartedAt[key] = nil
      recheckKeys.remove(key)
      probes.removeValue(forKey: key)?.cancel()
      for waiter in waiters.removeValue(forKey: key) ?? [] { waiter.resume() }
    }
    for (key, server) in knownServers where (probeStartedAt[key] ?? 0) < lastPathChange {
      let hasResolveWaiting = waiters[key]?.isEmpty == false
      startProbe(identity: server.identity, session: server.session, isRecheck: !hasResolveWaiting)
    }
  }
}

/// Resumes its continuation for whichever caller gets there first, so a race
/// between a probe and its deadline resumes exactly once.
@MainActor
private final class ProbeWaiter {
  private var continuation: CheckedContinuation<Void, Never>?
  var deadline: Task<Void, Never>?

  var isPending: Bool { continuation != nil }

  init(_ continuation: CheckedContinuation<Void, Never>) {
    self.continuation = continuation
  }

  func resume() {
    deadline?.cancel()
    continuation?.resume()
    continuation = nil
  }
}
