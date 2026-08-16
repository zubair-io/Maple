// WorkerEventsClient.swift — the `/api/events` WebSocket.
//
// The first WebSocket client in this codebase. Protocol contract lives in
// src/api/src/routes/events.ts:
//
//   • The access token is NOT in the URL — it leaked into proxy and access
//     logs (#863). Connect first, then send `{ "type": "auth", "token": … }`
//     as the first frame.
//   • The socket stays silent until that frame authenticates, and the server
//     closes it after WS_AUTH_TIMEOUT_MS if none arrives.
//   • After auth the channel is server→client push only; client frames are
//     ignored.
//   • Origin is checked at the handshake, but `isWsOriginAllowed` returns
//     true for a missing Origin ("non-browser client; not subject to
//     CSWSH"), so a native client sends none.

import Foundation
import OSLog

private let workerEventsLog = Logger(
  subsystem: "app.justmaple.aperture", category: "Cloud.WorkerEvents")

/// What the events stream emits.
///
/// Connection state travels in-band rather than as separate observable
/// state on the actor. The client reconnects internally, so without
/// `.connected` / `.disconnected` a consumer cannot tell a live feed from a
/// silently retrying one — it would only learn the socket died when the
/// stream *finished*, which happens on teardown, not on a drop.
public enum WorkerEventsUpdate: Sendable, Equatable {
  case connected
  case disconnected
  case status(WorkersStatusFrame)
}

public actor WorkerEventsClient {

  /// Reconnect delays in seconds, matching worker-events.service.ts. The
  /// last value repeats for every subsequent attempt rather than growing —
  /// a self-hosted box coming back from a reboot shouldn't push the client
  /// into multi-minute silence.
  public static let backoffSchedule: [Double] = [1, 2, 4, 8, 15]

  /// Walks `backoffSchedule` across consecutive failures.
  ///
  /// This is a type rather than a free `delay(attempt:)` function because
  /// the bug it replaces lived in the *caller*: the run loop incremented
  /// its counter before asking for a delay, so the first retry waited 2s
  /// instead of 1s while a unit test of the arithmetic alone still passed.
  /// Driving the same object from both the loop and the test closes that
  /// gap.
  public struct BackoffSequencer: Sendable, Equatable {
    private var attempt = 0

    public init() {}

    /// Delay for the next retry, then advance.
    public mutating func nextDelay() -> Double {
      let index = min(attempt, WorkerEventsClient.backoffSchedule.count - 1)
      attempt += 1
      return WorkerEventsClient.backoffSchedule[index]
    }

    /// Call after a connection succeeds, so a later drop starts from 1s
    /// again rather than continuing a stale escalation.
    public mutating func reset() {
      attempt = 0
    }
  }

  /// How long to wait for any frame before treating the socket as dead.
  ///
  /// Nominally the server broadcasts on a ~2s cadence (`COUNT_INTERVAL_MS`
  /// in workers/status-broadcast.ts), which is what the original 15s was
  /// sized against. But a counted tick fans out `countDocuments` across
  /// every stage, and `tickInFlight` suppresses overlapping passes — so on
  /// a large library the real gap between counted frames is far longer than
  /// the local test case suggested. At 15s this watchdog could tear the
  /// socket down before a counted tick ever landed, reconnect, receive
  /// another zeroed registry snapshot, and loop there indefinitely (#2910).
  ///
  /// 60s still catches a silently-dropped connection well before an
  /// operator would trust the stale numbers, without racing the server's
  /// own count pass.
  ///
  /// Without this, a device that loses connectivity *silently* — iOS
  /// dropping Wi-Fi with no TCP FIN, which is routine — leaves
  /// `receive()` suspended forever. The UI would keep claiming the feed is
  /// live while showing counts that stopped updating, which is worse than
  /// showing a disconnect, because nothing prompts a reconnect.
  public static let readTimeout: Duration = .seconds(60)

  /// Raised when `readTimeout` elapses with no frame. Surfaces as a normal
  /// connection drop, so the run loop reconnects on the usual backoff.
  struct FeedWentSilent: Error {}

  /// `https` → `wss`, `http` → `ws`, path `/api/events`.
  public static func eventsURL(for server: URL) -> URL? {
    guard var components = URLComponents(url: server, resolvingAgainstBaseURL: false) else {
      return nil
    }
    switch components.scheme?.lowercased() {
    case "https", "wss": components.scheme = "wss"
    case "http", "ws": components.scheme = "ws"
    default: return nil
    }
    components.path = "/api/events"
    components.query = nil
    components.fragment = nil
    return components.url
  }

  public static func authFrame(token: String) throws -> String {
    let payload: [String: String] = ["type": "auth", "token": token]
    let data = try JSONSerialization.data(withJSONObject: payload)
    guard let text = String(data: data, encoding: .utf8) else {
      throw ServerAdminError(statusCode: 0, message: "could not encode auth frame")
    }
    return text
  }

  private let server: URL
  private let urlSession: URLSession
  private let tokenProvider: @Sendable () async throws -> String
  private var task: URLSessionWebSocketTask?
  private var runLoop: Task<Void, Never>?

  public init(
    server: URL,
    urlSession: URLSession = .shared,
    tokenProvider: @escaping @Sendable () async throws -> String
  ) {
    self.server = server
    self.urlSession = urlSession
    self.tokenProvider = tokenProvider
  }

  /// Stream of status frames, reconnecting until the consumer stops
  /// iterating or `stop()` is called.
  public func frames() -> AsyncStream<WorkerEventsUpdate> {
    // A previous stream may still be running if the caller re-subscribed
    // without letting the old one terminate. One socket per client.
    runLoop?.cancel()

    let (stream, continuation) = AsyncStream<WorkerEventsUpdate>.makeStream()
    let loop = Task { await self.run(yielding: continuation) }
    runLoop = loop
    continuation.onTermination = { [weak self] _ in
      // Not actor-isolated, so the hop is real here — unlike the
      // assignment above, which runs on the actor already.
      //
      // That hop is exactly the hazard: by the time this lands on the
      // actor, a remount may already have installed a NEW loop and socket.
      // Tearing down unconditionally would cancel the replacement and
      // leave the remounted view dead with nothing to trigger a retry —
      // and remounting is ordinary here, since switching ServerAdmin
      // sections and back recreates the view. Hence stop-if-still-current.
      loop.cancel()
      Task { await self?.stopIfCurrent(loop) }
    }
    return stream
  }

  /// True when `terminating` is still the live loop, i.e. no newer
  /// `frames()` has superseded it. Pure so the race is testable without
  /// driving actor internals.
  static func shouldTearDown(
    current: Task<Void, Never>?, terminating: Task<Void, Never>
  ) -> Bool {
    current == terminating
  }

  /// Tear down only if the terminating stream is still the current one.
  private func stopIfCurrent(_ loop: Task<Void, Never>) {
    guard Self.shouldTearDown(current: runLoop, terminating: loop) else { return }
    stop()
  }

  public func stop() {
    runLoop?.cancel()
    runLoop = nil
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
  }

  private func run(yielding continuation: AsyncStream<WorkerEventsUpdate>.Continuation) async {
    var backoff = BackoffSequencer()
    while !Task.isCancelled {
      do {
        try await connectAndStream(yielding: continuation)
        // A clean close still means we lost the feed; reconnect, but treat
        // it as a fresh sequence rather than continuing to back off.
        backoff.reset()
      } catch is CancellationError {
        break
      } catch {
        workerEventsLog.debug(
          "events socket dropped: \(error.localizedDescription, privacy: .public)")
      }
      // Whatever ended the connection, the consumer is no longer live.
      continuation.yield(.disconnected)
      guard !Task.isCancelled else { break }
      try? await Task.sleep(for: .seconds(backoff.nextDelay()))
    }
    continuation.finish()
  }

  private func connectAndStream(
    yielding continuation: AsyncStream<WorkerEventsUpdate>.Continuation
  ) async throws {
    guard let url = Self.eventsURL(for: server) else {
      throw ServerAdminError(statusCode: 0, message: "server URL has no ws/wss equivalent")
    }
    let token = try await tokenProvider()
    let socket = urlSession.webSocketTask(with: url)
    task = socket
    socket.resume()
    defer {
      socket.cancel(with: .goingAway, reason: nil)
      if task === socket { task = nil }
    }

    // Auth must be the first frame; the server closes the socket if it
    // doesn't arrive.
    try await socket.send(.string(Self.authFrame(token: token)))
    continuation.yield(.connected)

    let decoder = JSONDecoder()
    while !Task.isCancelled {
      let message = try await Self.receive(from: socket, timeout: Self.readTimeout)
      guard let data = Self.payload(of: message) else { continue }
      // Non-status frames share the channel; ignore what we don't model
      // rather than tearing down the socket for it.
      guard let frame = try? decoder.decode(WorkersStatusFrame.self, from: data),
        frame.type == "workers-status"
      else { continue }
      continuation.yield(.status(frame))
    }
  }

  /// `socket.receive()` bounded by `timeout`.
  ///
  /// Races the read against a sleep. Whichever finishes first wins and the
  /// loser is cancelled, so a timeout throws `FeedWentSilent` and unwinds
  /// into the run loop's reconnect path exactly like a real drop.
  private static func receive(
    from socket: URLSessionWebSocketTask, timeout: Duration
  ) async throws -> URLSessionWebSocketTask.Message {
    try await withThrowingTaskGroup(of: URLSessionWebSocketTask.Message.self) { group in
      group.addTask { try await socket.receive() }
      group.addTask {
        try await Task.sleep(for: timeout)
        throw FeedWentSilent()
      }
      defer { group.cancelAll() }
      guard let first = try await group.next() else { throw FeedWentSilent() }
      return first
    }
  }

  private static func payload(of message: URLSessionWebSocketTask.Message) -> Data? {
    switch message {
    case .string(let text): return Data(text.utf8)
    case .data(let data): return data
    @unknown default: return nil
    }
  }
}
