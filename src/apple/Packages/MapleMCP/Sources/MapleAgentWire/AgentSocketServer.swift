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
  private let launchAcceptThread: @Sendable (Thread) -> Void
  private let lifecycleLock = NSLock()
  private let lock = NSLock()
  private struct Listener {
    let fd: Int32
    let wakeRead: Int32
    let wakeWrite: Int32
    let finished: DispatchGroup
  }
  private var listener: Listener?
  private var clientFDs: Set<Int32> = []

  public convenience init(path: String, handler: @escaping Handler) {
    self.init(path: path, handler: handler, launchAcceptThread: { $0.start() })
  }

  init(
    path: String, handler: @escaping Handler,
    launchAcceptThread: @escaping @Sendable (Thread) -> Void
  ) {
    self.path = path
    self.handler = handler
    self.launchAcceptThread = launchAcceptThread
  }

  public var isRunning: Bool { lock.withLock { listener != nil } }

  public func start() throws {
    lifecycleLock.lock()
    defer { lifecycleLock.unlock() }
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
    guard fcntl(fd, F_SETFL, O_NONBLOCK) == 0 else {
      let code = errno
      close(fd)
      unlink(path)
      throw AgentSocketError.system(call: "fcntl", errno: code)
    }
    var wake = [Int32](repeating: -1, count: 2)
    guard pipe(&wake) == 0 else {
      let code = errno
      close(fd)
      unlink(path)
      throw AgentSocketError.system(call: "pipe", errno: code)
    }
    let listener = Listener(
      fd: fd, wakeRead: wake[0], wakeWrite: wake[1], finished: DispatchGroup())
    listener.finished.enter()
    lock.withLock { self.listener = listener }
    let thread = Thread { [weak self] in
      guard let self else {
        listener.finished.leave()
        return
      }
      acceptLoop(listener)
    }
    thread.name = "maple-agent-accept"
    launchAcceptThread(thread)
  }

  public func stop() {
    lifecycleLock.lock()
    defer { lifecycleLock.unlock() }
    let retired = lock.withLock { () -> Listener? in
      defer {
        listener = nil
        clientFDs.removeAll()
      }
      // serve removes each descriptor under this same lock. Shutdown while
      // ownership is pinned, rather than using a snapshot that can be reused.
      for client in clientFDs { shutdown(client, SHUT_RDWR) }
      return listener
    }
    guard let retired else { return }
    // A pipe wakes poll even when the socket pathname has been removed.
    // Darwin shutdown on a listening socket does not wake a blocked accept.
    try? UnixSocket.writeAll(retired.wakeWrite, Data([1]))
    // Retain ownership until even a not-yet-scheduled accept thread exits.
    // Closing sooner lets a replacement listener reuse this descriptor and
    // be accepted by the stopped server's old handler.
    retired.finished.wait()
    close(retired.fd)
    close(retired.wakeRead)
    close(retired.wakeWrite)
    unlink(path)
  }

  deinit { stop() }

  private func acceptLoop(_ listener: Listener) {
    defer { listener.finished.leave() }
    while lock.withLock({ self.listener?.fd == listener.fd }) {
      var events = [
        pollfd(fd: listener.fd, events: Int16(POLLIN), revents: 0),
        pollfd(fd: listener.wakeRead, events: Int16(POLLIN), revents: 0),
      ]
      let ready = poll(&events, nfds_t(events.count), -1)
      if ready < 0 {
        if errno == EINTR { continue }
        return
      }
      guard events[1].revents == 0, events[0].revents & Int16(POLLIN) != 0 else { return }
      let client = accept(listener.fd, nil, nil)
      if client < 0 {
        if errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK { continue }
        return
      }
      // Darwin accepts inherit O_NONBLOCK; connection readers are blocking.
      let flags = fcntl(client, F_GETFL)
      guard flags >= 0, fcntl(client, F_SETFL, flags & ~O_NONBLOCK) == 0 else {
        close(client)
        continue
      }
      var uid: uid_t = 0
      var gid: gid_t = 0
      guard getpeereid(client, &uid, &gid) == 0, uid == getuid() else {
        close(client)
        continue
      }
      var on: Int32 = 1
      setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
      let admitted = lock.withLock {
        guard self.listener?.fd == listener.fd else { return false }
        _ = clientFDs.insert(client)
        return true
      }
      guard admitted else {
        close(client)
        return
      }
      let thread = Thread { [weak self] in
        guard let self else {
          close(client)
          return
        }
        serve(client)
      }
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
