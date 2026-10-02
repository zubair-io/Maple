import Foundation
import Network

/// Loopback HTTP fixture for the real URLSession download delegate. Listener
/// callbacks run on one queue; request observations are protected by the lock.
final class CloudOriginalHTTPFixture: @unchecked Sendable {
  private let listener: NWListener
  private let queue = DispatchQueue(label: "maple.cloud-original-test")
  private let lock = NSLock()
  private var observed: [String] = []
  let original = Data((0..<262_144).map { UInt8($0 % 251) })

  var url: URL { URL(string: "http://127.0.0.1:\(listener.port!.rawValue)/maple/")! }
  var requests: [String] { lock.withLock { observed } }

  private init() throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
  }

  static func start() async throws -> CloudOriginalHTTPFixture {
    let fixture = try CloudOriginalHTTPFixture()
    fixture.listener.newConnectionHandler = { [fixture] connection in
      let request = Request(connection: connection, fixture: fixture)
      connection.start(queue: fixture.queue)
      request.receive()
    }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      fixture.listener.stateUpdateHandler = { state in
        switch state {
        case .ready:
          fixture.listener.stateUpdateHandler = nil
          continuation.resume()
        case .failed(let error):
          fixture.listener.stateUpdateHandler = nil
          continuation.resume(throwing: error)
        default: break
        }
      }
      fixture.listener.start(queue: fixture.queue)
    }
    return fixture
  }

  func stop() { listener.cancel() }

  private func response(for request: String) -> Data {
    lock.withLock { observed.append(request) }
    let target = request.split(separator: " ").dropFirst().first.map(String.init) ?? ""
    let folders = """
      [{"id":"f1","slug":"library","path":"/srv/photos/Library","label":"Library",
        "last_scan":null,"file_count":1,"created_at":"2026-01-01T00:00:00Z"}]
      """
    let isFolders = target == "/maple/api/folders"
    let isOriginal = target == "/maple/api/image/library/My%20Album/a%20%23%3F.dng"
    let authorized = request.lowercased().contains("authorization: bearer original-token")
    let status = authorized && (isFolders || isOriginal) ? 200 : 404
    let body = isFolders ? Data(folders.utf8) : isOriginal ? original : Data("not found".utf8)
    let header =
      "HTTP/1.1 \(status) Response\r\nContent-Length: \(body.count)\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n"
    return Data(header.utf8) + body
  }

  /// Buffering is confined to the fixture's serial network queue.
  private final class Request: @unchecked Sendable {
    let connection: NWConnection
    let fixture: CloudOriginalHTTPFixture
    var buffer = Data()
    init(connection: NWConnection, fixture: CloudOriginalHTTPFixture) {
      self.connection = connection
      self.fixture = fixture
    }
    func receive() {
      connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) {
        [self] data, _, complete, error in
        if let data { buffer.append(data) }
        guard error == nil else {
          connection.cancel()
          return
        }
        if buffer.range(of: Data("\r\n\r\n".utf8)) != nil {
          let response = fixture.response(for: String(decoding: buffer, as: UTF8.self))
          if response.count > 65_536 {
            // A partial transfer precedes completion: the regression cannot
            // pass by inventing a terminal-only progress update.
            connection.send(
              content: response.prefix(65_536),
              completion: .contentProcessed { [self] error in
                guard error == nil else {
                  connection.cancel()
                  return
                }
                fixture.queue.asyncAfter(deadline: .now() + .milliseconds(200)) { [connection] in
                  connection.send(
                    content: response.dropFirst(65_536),
                    completion: .contentProcessed { _ in connection.cancel() })
                }
              })
          } else {
            connection.send(
              content: response,
              completion: .contentProcessed { [connection] _ in connection.cancel() })
          }
        } else if complete {
          connection.cancel()
        } else {
          receive()
        }
      }
    }
  }
}
