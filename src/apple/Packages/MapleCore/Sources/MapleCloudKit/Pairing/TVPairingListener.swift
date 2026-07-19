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

  private let session: TVPairingSession
  private let onPaired: (SealedPairingGrant) -> Void
  private let queue = DispatchQueue(label: "app.justmaple.aperture.tv-pairing-listener")

  private var listener: NWListener?
  /// Connections keyed by identity — Network framework does not keep an
  /// `NWConnection` alive on your behalf once `start()` returns; the caller
  /// must hold a strong reference for the life of the exchange or the
  /// connection can be torn down mid-I/O.
  private var connections: [ObjectIdentifier: NWConnection] = [:]

  public init(session: TVPairingSession, onPaired: @escaping (SealedPairingGrant) -> Void) {
    self.session = session
    self.onPaired = onPaired
  }

  public enum ListenerError: Error {
    /// `NWListener` reported `.ready` but exposed no bound port — should be
    /// unreachable in practice; guards against silently returning a bogus 0.
    case noPortAfterReady
  }

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
    semaphore.wait()

    if let startError { throw startError }
    guard let boundPort else { throw ListenerError.noPortAfterReady }
    return boundPort
  }

  /// Stops accepting new connections. Connections already in flight finish
  /// their own send-then-cancel sequence independently (see `respond`).
  public func stop() {
    queue.async { [weak self] in
      self?.listener?.cancel()
      self?.listener = nil
    }
  }

  // MARK: - Connection lifecycle

  private func accept(_ connection: NWConnection) {
    let id = ObjectIdentifier(connection)
    connections[id] = connection
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .failed, .cancelled:
        self?.queue.async { self?.connections.removeValue(forKey: id) }
      default:
        break
      }
    }
    connection.start(queue: queue)
    receive(on: connection, buffer: Data())
  }

  private func receive(on connection: NWConnection, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
      guard let self else { return }
      self.queue.async {
        var accumulated = buffer
        if let data, !data.isEmpty {
          accumulated.append(data)
        }

        if let request = Self.parseCompleteRequest(accumulated) {
          self.handle(request, on: connection)
          return
        }

        if accumulated.count > Self.maxBodySize {
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

  private static func parseCompleteRequest(_ buffer: Data) -> ParsedRequest? {
    guard let separatorRange = buffer.range(of: headerBodySeparator) else { return nil }
    guard let headerString = String(data: buffer[..<separatorRange.lowerBound], encoding: .utf8) else {
      return nil
    }
    let lines = headerString.components(separatedBy: "\r\n")
    guard let requestLine = lines.first else { return nil }
    let requestParts = requestLine.split(separator: " ")
    guard requestParts.count >= 2 else { return nil }
    let method = String(requestParts[0])
    let path = String(requestParts[1])

    let contentLength = lines.dropFirst().reduce(into: 0) { length, line in
      let parts = line.split(separator: ":", maxSplits: 1)
      guard parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length"
      else { return }
      length = Int(parts[1].trimmingCharacters(in: .whitespaces)) ?? length
    }

    let bodyStart = separatorRange.upperBound
    let availableBodyBytes = buffer.count - bodyStart
    guard availableBodyBytes >= contentLength else { return nil }
    let body = buffer[bodyStart..<(bodyStart + contentLength)]
    return ParsedRequest(method: method, path: path, body: Data(body))
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
