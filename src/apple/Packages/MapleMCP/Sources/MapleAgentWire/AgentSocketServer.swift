import Darwin
import Foundation

/// Serves `AgentRequest`s on a Unix socket. Each connection gets its own
/// thread (the only clients are a handful of local bridges); requests on a
/// connection are answered in order. Peers running as another user are
/// refused even though the socket's mode already forbids them.
public final class AgentSocketServer: @unchecked Sendable {
  public typealias Handler = @Sendable (AgentRequest) async -> AgentResponse

  public let path: String
  private let handler: Handler
  private let lock = NSLock()
  private var listenFD: Int32 = -1
  private var clientFDs: Set<Int32> = []

  public init(path: String, handler: @escaping Handler) {
    self.path = path
    self.handler = handler
  }

  public var isRunning: Bool { lock.withLock { listenFD >= 0 } }

  public func start() throws {
    guard !isRunning else { return }
    var address = try UnixSocket.makeAddress(path)
    if FileManager.default.fileExists(atPath: path) {
      if let probe = try? UnixSocket.connect(path) {
        close(probe)
        throw AgentSocketError.addressInUse(path)
      }
      unlink(path)
    }
    let fd = try UnixSocket.makeSocket()
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard bound == 0 else {
      let code = errno
      close(fd)
      throw AgentSocketError.system(call: "bind", errno: code)
    }
    chmod(path, 0o600)
    guard listen(fd, 8) == 0 else {
      let code = errno
      close(fd)
      unlink(path)
      throw AgentSocketError.system(call: "listen", errno: code)
    }
    lock.withLock { listenFD = fd }
    let thread = Thread { [weak self] in self?.acceptLoop(fd) }
    thread.name = "maple-agent-accept"
    thread.start()
  }

  public func stop() {
    let (fd, clients) = lock.withLock { () -> (Int32, Set<Int32>) in
      defer {
        listenFD = -1
        clientFDs.removeAll()
      }
      return (listenFD, clientFDs)
    }
    guard fd >= 0 else { return }
    shutdown(fd, SHUT_RDWR)
    close(fd)
    unlink(path)
    for client in clients { shutdown(client, SHUT_RDWR) }
  }

  deinit { stop() }

  private func acceptLoop(_ fd: Int32) {
    while true {
      let client = accept(fd, nil, nil)
      if client < 0 {
        if errno == EINTR { continue }
        return
      }
      var uid: uid_t = 0
      var gid: gid_t = 0
      guard getpeereid(client, &uid, &gid) == 0, uid == getuid() else {
        close(client)
        continue
      }
      var on: Int32 = 1
      setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
      lock.withLock { _ = clientFDs.insert(client) }
      let thread = Thread { [weak self] in self?.serve(client) }
      thread.name = "maple-agent-connection"
      thread.start()
    }
  }

  private func serve(_ client: Int32) {
    defer {
      lock.withLock { _ = clientFDs.remove(client) }
      close(client)
    }
    var reader = LineReader(fd: client)
    while let line = try? reader.nextLine() {
      let response: AgentResponse
      if let json = try? JSONValue.decode(line), let request = AgentRequest(json: json) {
        response = Self.blockingCall(handler, request)
      } else {
        response = AgentResponse(
          id: -1,
          outcome: .failure(
            AgentError(code: "malformed_request", message: "Expected one JSON request per line.")))
      }
      guard (try? UnixSocket.writeLine(client, response.json)) != nil else { return }
    }
  }

  private static func blockingCall(_ handler: @escaping Handler, _ request: AgentRequest)
    -> AgentResponse
  {
    let box = ResponseBox()
    let done = DispatchSemaphore(value: 0)
    Task {
      box.value = await handler(request)
      done.signal()
    }
    done.wait()
    return box.value
      ?? AgentResponse(
        id: request.id,
        outcome: .failure(
          AgentError(code: "internal", message: "The handler produced no response.")))
  }
}

private final class ResponseBox: @unchecked Sendable {
  var value: AgentResponse?
}

/// One request per connection: connect, send, await the answer, close.
public struct AgentSocketClient: Sendable {
  public let path: String
  public let timeout: TimeInterval

  public init(path: String = AgentSocketLocation.defaultPath(), timeout: TimeInterval = 60) {
    self.path = path
    self.timeout = timeout
  }

  public func send(_ request: AgentRequest) throws -> AgentResponse {
    let fd = try UnixSocket.connect(path)
    defer { close(fd) }
    UnixSocket.setReceiveTimeout(fd, seconds: timeout)
    try UnixSocket.writeLine(fd, request.json)
    var reader = LineReader(fd: fd)
    guard let line = try reader.nextLine() else { throw AgentSocketError.connectionClosed }
    guard let json = try? JSONValue.decode(line), let response = AgentResponse(json: json) else {
      throw AgentSocketError.malformedResponse
    }
    return response
  }
}
