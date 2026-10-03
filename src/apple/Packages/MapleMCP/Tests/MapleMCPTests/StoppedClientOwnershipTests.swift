import Darwin
import Foundation
import XCTest

@testable import MapleAgentWire

final class StoppedClientOwnershipTests: XCTestCase {
  func testStopCannotShutdownAnUnrelatedSocketReusingTheReleasedClientDescriptor() throws {
    let directory = URL(fileURLWithPath: "/tmp").appendingPathComponent(
      "mcp-client-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("a.sock").path
    let launch = RecordedAcceptLaunch()
    let server = AgentSocketServer(
      path: path,
      handler: { AgentResponse(id: $0.id, outcome: .success(AgentPayload(result: true))) },
      launchAcceptThread: launch.start)
    try server.start()
    defer { server.stop() }
    XCTAssertEqual(launch.started.wait(timeout: .now() + 5), .success)
    var peer = try UnixSocket.connect(path)
    defer { if peer >= 0 { close(peer) } }
    UnixSocket.setReceiveTimeout(peer, seconds: 5)
    try UnixSocket.writeLine(peer, AgentRequest(id: 1, tool: "current", arguments: [:]).json)
    var reader = LineReader(fd: peer)
    XCTAssertNotNil(try reader.nextLine())
    let accepted = try XCTUnwrap(
      (0..<1024).map(Int32.init).first {
        Self.isAcceptedSocket($0, path: path)
      })
    // Pin only this fixture's listener thread after an actual peer was admitted.
    let port = launch.port
    // With no further connections queued, its normal kernel wait is poll,
    // outside the registry lock. Do not suspend a running critical section.
    let idleDeadline = Date().addingTimeInterval(5)
    while !Self.isWaiting(port) && Date() < idleDeadline { sched_yield() }
    guard Self.isWaiting(port) else { return XCTFail("The listener did not enter its idle wait") }
    guard thread_suspend(port) == KERN_SUCCESS else {
      return XCTFail("Could not fence this fixture's accept thread")
    }
    var suspended = true
    defer { if suspended { thread_resume(port) } }
    let stopped = DispatchSemaphore(value: 0)
    Thread {
      server.stop()
      stopped.signal()
    }.start()
    var byte: UInt8 = 0
    // Shutdown must precede listener completion, which is deliberately fenced.
    XCTAssertEqual(read(peer, &byte, 1), 0)
    close(peer)
    peer = -1
    let deadline = Date().addingTimeInterval(5)
    while fcntl(accepted, F_GETFD) >= 0 && Date() < deadline { sched_yield() }
    guard fcntl(accepted, F_GETFD) == -1, errno == EBADF else {
      return XCTFail("The actual connection owner did not release its descriptor")
    }
    var unrelated = [Int32](repeating: -1, count: 2)
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &unrelated) == 0 else {
      throw AgentSocketError.system(call: "socketpair", errno: errno)
    }
    defer {
      close(unrelated[0])
      close(unrelated[1])
    }
    if !unrelated.contains(accepted) {
      // Force reuse of the observed, now-released number inside this test process.
      guard dup2(unrelated[0], accepted) == accepted else {
        throw AgentSocketError.system(call: "dup2", errno: errno)
      }
      close(unrelated[0])
      unrelated[0] = accepted
    }
    for descriptor in unrelated {
      var on: Int32 = 1
      setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
      UnixSocket.setReceiveTimeout(descriptor, seconds: 5)
    }
    XCTAssertEqual(thread_resume(port), KERN_SUCCESS)
    suspended = false
    XCTAssertEqual(stopped.wait(timeout: .now() + 5), .success)
    try UnixSocket.writeAll(unrelated[0], Data([0x7F]))
    XCTAssertEqual(read(unrelated[1], &byte, 1), 1)
    XCTAssertEqual(byte, 0x7F)
  }

  private static func isAcceptedSocket(_ descriptor: Int32, path: String) -> Bool {
    let flags = fcntl(descriptor, F_GETFL)
    // The actual listener is nonblocking; admitted connection readers are blocking.
    guard flags >= 0, flags & O_NONBLOCK == 0 else { return false }
    var address = sockaddr_un()
    var length = socklen_t(MemoryLayout<sockaddr_un>.size)
    let result = withUnsafeMutablePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        getsockname(descriptor, $0, &length)
      }
    }
    guard result == 0, address.sun_family == AF_UNIX else { return false }
    let bound = withUnsafeBytes(of: address.sun_path) {
      String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self)
    }
    return bound == path
  }

  private static func isWaiting(_ port: mach_port_t) -> Bool {
    var info = thread_basic_info_data_t()
    let capacity = MemoryLayout<thread_basic_info_data_t>.size / MemoryLayout<integer_t>.size
    var count = mach_msg_type_number_t(capacity)
    let result = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: capacity) {
        thread_info(port, thread_flavor_t(THREAD_BASIC_INFO), $0, &count)
      }
    }
    return result == KERN_SUCCESS && info.run_state == TH_STATE_WAITING
  }
}

private final class RecordedAcceptLaunch: @unchecked Sendable {
  let started = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var recordedPort: mach_port_t = 0
  var port: mach_port_t { lock.withLock { recordedPort } }

  func start(_ thread: Thread) {
    Thread {
      self.lock.withLock { self.recordedPort = pthread_mach_thread_np(pthread_self()) }
      self.started.signal()
      thread.main()
    }.start()
  }
}
