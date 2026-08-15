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

public actor WorkerEventsClient {

  /// Reconnect delays in seconds, matching worker-events.service.ts. The
  /// last value repeats for every subsequent attempt rather than growing —
  /// a self-hosted box coming back from a reboot shouldn't push the client
  /// into multi-minute silence.
  public static let backoffSchedule: [Double] = [1, 2, 4, 8, 15]

  public static func backoffDelay(attempt: Int) -> Double {
    guard attempt > 0 else { return backoffSchedule[0] }
    let index = min(attempt, backoffSchedule.count - 1)
    return backoffSchedule[index]
  }

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
  public func frames() -> AsyncStream<WorkersStatusFrame> {
    AsyncStream { continuation in
      let loop = Task { await self.run(yielding: continuation) }
      Task { await self.store(loop: loop) }
      continuation.onTermination = { _ in
        loop.cancel()
        Task { await self.stop() }
      }
    }
  }

  public func stop() {
    runLoop?.cancel()
    runLoop = nil
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
  }

  private func store(loop: Task<Void, Never>) {
    runLoop = loop
  }

  private func run(yielding continuation: AsyncStream<WorkersStatusFrame>.Continuation) async {
    var attempt = 0
    while !Task.isCancelled {
      do {
        try await connectAndStream(yielding: continuation)
        // A clean close still means we lost the feed; reconnect, but treat
        // it as a fresh sequence rather than continuing to back off.
        attempt = 0
      } catch is CancellationError {
        break
      } catch {
        workerEventsLog.debug("events socket dropped: \(error.localizedDescription, privacy: .public)")
        attempt += 1
      }
      guard !Task.isCancelled else { break }
      let delay = Self.backoffDelay(attempt: attempt)
      try? await Task.sleep(for: .seconds(delay))
    }
    continuation.finish()
  }

  private func connectAndStream(
    yielding continuation: AsyncStream<WorkersStatusFrame>.Continuation
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

    let decoder = JSONDecoder()
    while !Task.isCancelled {
      let message = try await socket.receive()
      guard let data = Self.payload(of: message) else { continue }
      // Non-status frames share the channel; ignore what we don't model
      // rather than tearing down the socket for it.
      guard let frame = try? decoder.decode(WorkersStatusFrame.self, from: data),
        frame.type == "workers-status"
      else { continue }
      continuation.yield(frame)
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
