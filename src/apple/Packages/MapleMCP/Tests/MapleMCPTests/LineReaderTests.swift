import Darwin
import Foundation
import XCTest

@testable import MapleAgentWire

final class LineReaderTests: XCTestCase {
  private func withStream(_ bytes: Data, check: (inout LineReader) throws -> Void) throws {
    var descriptors = [Int32](repeating: -1, count: 2)
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
      throw AgentSocketError.system(call: "socketpair", errno: errno)
    }
    let readFD = descriptors[0]
    let writeFD = descriptors[1]
    defer { close(readFD) }
    UnixSocket.setReceiveTimeout(readFD, seconds: 5)
    var on: Int32 = 1
    setsockopt(writeFD, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    let finished = expectation(description: "writer released its socket")
    Thread {
      defer {
        close(writeFD)
        finished.fulfill()
      }
      try? UnixSocket.writeAll(writeFD, bytes)
    }.start()
    var reader = LineReader(fd: readFD)
    defer {
      shutdown(readFD, SHUT_RDWR)
      wait(for: [finished], timeout: 10)
    }
    try check(&reader)
  }

  func testTwoCoalescedFramesRoundTrip() throws {
    var descriptors = [Int32](repeating: -1, count: 2)
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
      throw AgentSocketError.system(call: "socketpair", errno: errno)
    }
    defer {
      close(descriptors[0])
      close(descriptors[1])
    }
    // Both small frames are already queued before the reader's first read.
    try UnixSocket.writeAll(descriptors[1], Data("first\nsecond\n".utf8))
    var reader = LineReader(fd: descriptors[0])
    XCTAssertEqual(try reader.nextLine(), Data("first".utf8))
    XCTAssertEqual(try reader.nextLine(), Data("second".utf8))
  }

  func testExactLimitSplitAcrossReadsAndFollowingFrameRoundTrip() throws {
    // A 32 MiB frame necessarily spans the reader's 64 KiB reads.
    let frame = Data(repeating: 0x61, count: LineReader.maxLineBytes)
    var bytes = frame
    bytes.append(contentsOf: [0x0A, 0x62, 0x0A])
    try withStream(bytes) { reader in
      XCTAssertEqual(try reader.nextLine(), frame)
      XCTAssertEqual(try reader.nextLine(), Data([0x62]))
    }
  }

  func testOversizedTerminatedFrameIsRejected() throws {
    var bytes = Data(repeating: 0x61, count: LineReader.maxLineBytes + 1)
    bytes.append(0x0A)
    try withStream(bytes) { reader in
      XCTAssertThrowsError(try reader.nextLine()) {
        XCTAssertEqual($0 as? AgentSocketError, .messageTooLarge)
      }
    }
  }

  func testOversizedUnterminatedFrameIsRejected() throws {
    let bytes = Data(repeating: 0x61, count: LineReader.maxLineBytes + 1)
    try withStream(bytes) { reader in
      XCTAssertThrowsError(try reader.nextLine()) {
        XCTAssertEqual($0 as? AgentSocketError, .messageTooLarge)
      }
    }
  }

  func testServerClosesOversizedPeerWithoutDispatchAndRemainsHealthy() throws {
    let directory = URL(fileURLWithPath: "/tmp").appendingPathComponent(
      "mcp-bound-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("a.sock").path
    let server = AgentSocketServer(path: path) { request in
      XCTAssertEqual(request.tool, "healthy", "oversized frame must not reach the handler")
      return AgentResponse(id: request.id, outcome: .success(AgentPayload(result: true)))
    }
    try server.start()
    defer { server.stop() }
    let fd = try UnixSocket.connect(path)
    defer { close(fd) }
    UnixSocket.setReceiveTimeout(fd, seconds: 5)
    // Valid JSON would invoke a tool if the complete oversized request were accepted.
    var bytes = Data("{\"id\":1,\"tool\":\"oversized\",\"arguments\":{\"padding\":\"".utf8)
    bytes.append(Data(repeating: 0x61, count: LineReader.maxLineBytes))
    bytes.append(Data("\"}}\n".utf8))
    try? UnixSocket.writeAll(fd, bytes)
    var byte: UInt8 = 0
    let count = read(fd, &byte, 1)
    XCTAssertTrue(
      count == 0 || (count < 0 && errno == ECONNRESET), "peer must close, rather than hang")
    let response = try AgentSocketClient(path: path, timeout: 5).send(
      AgentRequest(id: 2, tool: "healthy", arguments: [:]))
    XCTAssertEqual(try response.outcome.get().result, true)
  }
}
