// src/apple/Packages/MapleCore/Sources/MapleCloudKit/Pairing/TVPairingListener.swift
import Foundation
import Network

/// TV-side transport for one `TVPairingSession`: a deliberately minimal HTTP
/// listener that speaks exactly one exchange — `POST /pair` with the sealed
/// grant ciphertext — and shuts itself down after the first successful
/// redeem. This is a single-purpose pairing socket, not a web server: any
/// other method or path gets a bare `404`, and a body over 64 KiB or one
/// that never completes gets rejected rather than buffered without bound.
///
/// All listener/connection state is confined to a single serial queue so the
/// accept/receive/redeem/respond sequence never races across connections.
public final class TVPairingListener {
  /// Body cap for the single `POST /pair` exchange this listener accepts.
  /// The real payload (base64 ciphertext + sender public key + token) is a
  /// few hundred bytes; 64 KiB is generous headroom against a hostile or
  /// buggy sender without letting a connection buffer unbounded memory.
  private static let maxBodySize = 64 * 1024
  private static let headerBodySeparator = Data("\r\n\r\n".utf8)

  /// How long a connection may sit after the TCP handshake without
  /// producing one complete, parseable request before this listener gives
  /// up on it and cancels it. `stop()` only cancels the *listener* (new
  /// connections stop being accepted) — it does not touch connections
  /// already in flight, so a connection that never sends a trailing
  /// `\r\n\r\n` (or whose declared `Content-Length` never fully arrives)
  /// would otherwise sit in `receive` forever. Injectable so tests can use
  /// a short bound instead of the real 10s. (Inlined as a literal default
  /// on `init` below, rather than referenced from a `private static let`,
  /// because a default-argument expression is evaluated at each call site
  /// and cannot see a `private` symbol from outside the declaring file.)
  private let session: TVPairingSession
  private let onPaired: (SealedPairingGrant) -> Void
  private let connectionTimeout: TimeInterval
  private let queue = DispatchQueue(label: "app.justmaple.aperture.tv-pairing-listener")

  private var listener: NWListener?
  /// Connections keyed by identity — Network framework does not keep an
  /// `NWConnection` alive on your behalf once `start()` returns; the caller
  /// must hold a strong reference for the life of the exchange or the
  /// connection can be torn down mid-I/O.
  private var connections: [ObjectIdentifier: NWConnection] = [:]
  /// Per-connection idle-receive deadlines, keyed the same way as
  /// `connections`. Cancelled as soon as the connection's fate is decided
  /// (request handled, malformed, too large, or the socket itself closes) —
  /// see `cancelDeadline(for:)` — so a well-behaved connection never lingers
  /// waiting on a timer that has nothing left to guard against.
  private var connectionDeadlines: [ObjectIdentifier: DispatchWorkItem] = [:]

  public init(
    session: TVPairingSession,
    connectionTimeout: TimeInterval = 10,
    onPaired: @escaping (SealedPairingGrant) -> Void
  ) {
    self.session = session
    self.connectionTimeout = connectionTimeout
    self.onPaired = onPaired
  }

  public enum ListenerError: Error {
    /// `NWListener` reported `.ready` but exposed no bound port — should be
    /// unreachable in practice; guards against silently returning a bogus 0.
    case noPortAfterReady
    /// `NWListener` never reached `.ready`/`.failed` within the start budget —
    /// fail fast (and cancel the half-open listener) rather than hang the
    /// caller's thread indefinitely on `semaphore.wait()`.
    case startTimedOut
  }

  /// How long `start()` waits for the listener to bind before giving up.
  private static let startTimeout: DispatchTimeInterval = .seconds(10)

  /// Starts the listener on an OS-assigned ephemeral port and blocks until
  /// the socket is actually bound (or binding fails), returning the bound
  /// port. Synchronous by design: callers need the real port back before
  /// they can render the pairing QR code, and `NWListener`'s state machine
  /// is otherwise fully asynchronous — there's no other way to observe
  /// "ready" without either blocking here or pushing the async dance onto
  /// every call site.
  @discardableResult
  public func start() throws -> UInt16 {
    let listener = try NWListener(using: .tcp, on: .any)
    self.listener = listener

    let semaphore = DispatchSemaphore(value: 0)
    var startError: Error?
    var boundPort: UInt16?

    // `[weak listener]`: capturing `listener` strongly here would create a
    // self-referential cycle (the listener retains this closure via
    // `stateUpdateHandler`, and the closure would retain the listener back),
    // leaking the socket even after `stop()` drops our own reference.
    listener.stateUpdateHandler = { [weak listener] state in
      switch state {
      case .ready:
        boundPort = listener?.port?.rawValue
        semaphore.signal()
      case .failed(let error):
        startError = error
        semaphore.signal()
      case .cancelled:
        semaphore.signal()
      default:
        break
      }
    }
    listener.newConnectionHandler = { [weak self] connection in
      self?.accept(connection)
    }
    listener.start(queue: queue)
    // Bounded wait: a listener that never advances to `.ready`/`.failed`
    // (OS bug, unexpected environment) must not hang the caller forever
    // (Copilot review, #2082). On timeout, cancel the half-open listener so
    // it doesn't leak, and surface a definite error.
    guard semaphore.wait(timeout: .now() + Self.startTimeout) == .success else {
      listener.cancel()
      self.listener = nil
      throw ListenerError.startTimedOut
    }

    if let startError { throw startError }
    guard let boundPort else { throw ListenerError.noPortAfterReady }
    return boundPort
  }

  /// Stops accepting new connections. Connections already in flight finish
  /// their own send-then-cancel sequence independently (see `respond`).
  ///
  /// Teardown must not depend on this wrapper's own lifetime (C3 review):
  /// the underlying `NWListener` is captured as a strong local **before**
  /// dispatching, rather than read via `self?.listener` from inside the
  /// queued closure. If the caller drops its last strong reference to this
  /// wrapper immediately after calling `stop()` — exactly what
  /// `PairingViewModel` does on regenerate (`listener?.stop(); listener =
  /// nil`) — this wrapper can deinit before the queued block runs; a
  /// `self?.` capture would then resolve to `nil` and the socket would
  /// never be cancelled, leaking a bound port across QR regenerations.
  /// Capturing the listener itself keeps cancellation independent of
  /// whether `self` is still alive when the block executes.
  public func stop() {
    guard let listenerToCancel = listener else { return }
    listener = nil
    queue.async {
      listenerToCancel.cancel()
    }
  }

  /// Backstop for the same hazard `stop()` guards against, for the case
  /// where this wrapper is deallocated without `stop()` ever being called
  /// explicitly. Same strong-local capture, so the cancel does not depend
  /// on `self` surviving until the queued block runs.
  deinit {
    guard let listenerToCancel = listener else { return }
    queue.async {
      listenerToCancel.cancel()
    }
  }

  // MARK: - Connection lifecycle

  private func accept(_ connection: NWConnection) {
    let id = ObjectIdentifier(connection)
    connections[id] = connection
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .failed, .cancelled:
        self?.queue.async {
          self?.connections.removeValue(forKey: id)
          self?.cancelDeadline(for: id)
        }
      default:
        break
      }
    }
    connection.start(queue: queue)
    scheduleDeadline(for: connection, id: id)
    receive(on: connection, buffer: Data())
  }

  /// Schedules this connection's idle-receive cutoff. Runs on the same
  /// serial `queue` every other piece of connection state lives on, so
  /// firing never races `cancelDeadline(for:)` removing the work item first.
  /// `[weak connection]`: if the connection has already torn down and been
  /// dropped from `connections` by the time this fires, there is nothing
  /// left to cancel.
  private func scheduleDeadline(for connection: NWConnection, id: ObjectIdentifier) {
    let workItem = DispatchWorkItem { [weak self, weak connection] in
      self?.connectionDeadlines.removeValue(forKey: id)
      connection?.cancel()
    }
    connectionDeadlines[id] = workItem
    queue.asyncAfter(deadline: .now() + connectionTimeout, execute: workItem)
  }

  /// Cancels a connection's deadline once its fate no longer depends on the
  /// timer — called both when the connection reaches `.failed`/`.cancelled`
  /// (above) and explicitly once `receive` has a definitive outcome
  /// (below), so a connection that behaves doesn't sit holding a live timer
  /// for the remainder of its window.
  private func cancelDeadline(for id: ObjectIdentifier) {
    connectionDeadlines.removeValue(forKey: id)?.cancel()
  }

  private func receive(on connection: NWConnection, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
      guard let self else { return }
      self.queue.async {
        var accumulated = buffer
        if let data, !data.isEmpty {
          accumulated.append(data)
        }

        let id = ObjectIdentifier(connection)
        switch Self.parseCompleteRequest(accumulated) {
        case .complete(let request):
          self.cancelDeadline(for: id)
          self.handle(request, on: connection)
          return
        case .malformed:
          // A header we could parse enough of to know it's broken (e.g. a
          // negative or non-numeric Content-Length) — reject now rather
          // than waiting on a byte count that can never be satisfied. The
          // connection stays answerable; the listener stays up.
          self.cancelDeadline(for: id)
          self.respond(status: 403, json: ["error": "malformed"], on: connection)
          return
        case .incomplete:
          break
        }

        if accumulated.count > Self.maxBodySize {
          self.cancelDeadline(for: id)
          self.respond(status: 403, json: ["error": "payload too large"], on: connection)
          return
        }

        if isComplete || error != nil {
          connection.cancel()
          return
        }

        self.receive(on: connection, buffer: accumulated)
      }
    }
  }

  // MARK: - Minimal HTTP/1.1 parsing

  private struct ParsedRequest {
    let method: String
    let path: String
    let body: Data
  }

  /// Outcome of scanning the buffer accumulated so far for one complete
  /// request. `.malformed` is distinct from `.incomplete`: `.incomplete`
  /// means "keep reading, this may yet become a valid request";
  /// `.malformed` means "this can never become one — reject it now" (e.g. a
  /// `Content-Length` that isn't a non-negative integer, so there is no byte
  /// count that would ever satisfy the "enough body bytes buffered" check).
  private enum ParseOutcome {
    case incomplete
    case malformed
    case complete(ParsedRequest)
  }

  private static func parseCompleteRequest(_ buffer: Data) -> ParseOutcome {
    guard let separatorRange = buffer.range(of: headerBodySeparator) else { return .incomplete }
    guard let headerString = String(data: buffer[..<separatorRange.lowerBound], encoding: .utf8) else {
      return .malformed
    }
    let lines = headerString.components(separatedBy: "\r\n")
    guard let requestLine = lines.first else { return .malformed }
    let requestParts = requestLine.split(separator: " ")
    guard requestParts.count >= 2 else { return .malformed }
    let method = String(requestParts[0])
    let path = String(requestParts[1])

    // `nil` here means "a Content-Length header is present but its value
    // failed to parse as a non-negative Int" (empty, non-numeric, or
    // negative like the DoS payload `Content-Length: -1`) — distinct from
    // "no header at all", which defaults to a body length of 0. Reducing
    // into `Int?` (rather than defaulting straight to 0) lets a malformed
    // value poison the result instead of being silently swallowed.
    let contentLengthResult: Int? = lines.dropFirst().reduce(0) { partial, line in
      guard let length = partial else { return nil }
      let parts = line.split(separator: ":", maxSplits: 1)
      guard parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length"
      else { return length }
      guard let parsed = Int(parts[1].trimmingCharacters(in: .whitespaces)), parsed >= 0 else { return nil }
      return parsed
    }
    guard let contentLength = contentLengthResult else { return .malformed }

    let bodyStart = separatorRange.upperBound
    let availableBodyBytes = buffer.count - bodyStart
    guard availableBodyBytes >= contentLength else { return .incomplete }
    // Belt-and-suspenders: even though `contentLength >= 0` is already
    // guaranteed above, never let a Range with lowerBound > upperBound
    // reach a slice — that shape of Range is exactly what traps the
    // process (SIGTRAP / exit 133) if this invariant is ever broken by a
    // future edit.
    let bodyEnd = bodyStart + contentLength
    guard bodyEnd >= bodyStart else { return .malformed }
    let body = buffer[bodyStart..<bodyEnd]
    return .complete(ParsedRequest(method: method, path: path, body: Data(body)))
  }

  // MARK: - Request handling

  private struct PairRequestBody: Decodable {
    let token: String
    let senderPublicKey: String
    let ciphertext: String
  }

  private func handle(_ request: ParsedRequest, on connection: NWConnection) {
    guard request.method == "POST", request.path == "/pair" else {
      respond(status: 404, json: ["error": "not found"], on: connection)
      return
    }
    guard request.body.count <= Self.maxBodySize else {
      respond(status: 403, json: ["error": "payload too large"], on: connection)
      return
    }
    guard
      let decoded = try? JSONDecoder().decode(PairRequestBody.self, from: request.body),
      let senderPublicKey = Data(base64Encoded: decoded.senderPublicKey),
      let ciphertext = Data(base64Encoded: decoded.ciphertext)
    else {
      respond(status: 403, json: ["error": "malformed"], on: connection)
      return
    }

    switch session.redeem(ciphertext: ciphertext, senderPublicKey: senderPublicKey, token: decoded.token) {
    case .success(let grant):
      // Notify the caller and stop accepting new connections BEFORE writing
      // the HTTP response: `connection.send` hands bytes to the kernel
      // asynchronously, so a caller observing the response over the network
      // must never be able to race ahead of `onPaired` actually having run.
      onPaired(grant)
      stop()
      respond(status: 200, json: ["ok": true], on: connection)
    case .failure(let error):
      respond(status: 403, json: ["error": "\(error)"], on: connection)
    }
  }

  // MARK: - Response writing

  private func respond(status: Int, json: [String: Any], on connection: NWConnection) {
    let body = (try? JSONSerialization.data(withJSONObject: json)) ?? Data()
    var head = "HTTP/1.1 \(status) \(Self.statusText(for: status))\r\n"
    head += "Content-Type: application/json\r\n"
    head += "Content-Length: \(body.count)\r\n"
    head += "Connection: close\r\n\r\n"
    var responseData = Data(head.utf8)
    responseData.append(body)

    connection.send(
      content: responseData,
      completion: .contentProcessed { _ in
        connection.cancel()
      })
  }

  private static func statusText(for status: Int) -> String {
    switch status {
    case 200: return "OK"
    case 403: return "Forbidden"
    case 404: return "Not Found"
    default: return "Error"
    }
  }
}
