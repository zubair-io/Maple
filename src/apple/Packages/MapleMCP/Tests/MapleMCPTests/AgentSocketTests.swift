import Foundation
import XCTest

@testable import MapleAgentWire

final class AgentSocketTests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    directory = URL(fileURLWithPath: "/tmp", isDirectory: true)
      .appendingPathComponent("mcp-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: directory)
  }

  private func socketPath() -> String { directory.appendingPathComponent("a.sock").path }

  func testRequestRoundTripsThroughARealSocket() throws {
    let path = socketPath()
    let server = AgentSocketServer(path: path) { request in
      AgentResponse(
        id: request.id,
        outcome: .success(
          AgentPayload(
            result: ["echo": .string(request.tool), "args": .object(request.arguments)],
            image: AgentImage(data: Data([0xFF, 0xD8, 0x00]), mimeType: "image/jpeg"))))
    }
    try server.start()
    defer { server.stop() }

    let response = try AgentSocketClient(path: path, timeout: 5).send(
      AgentRequest(id: 7, tool: "maple_get_active_photo", arguments: ["k": 1.5]))

    XCTAssertEqual(response.id, 7)
    let payload = try response.outcome.get()
    XCTAssertEqual(payload.result["echo"], "maple_get_active_photo")
    XCTAssertEqual(payload.result["args"]?["k"], 1.5)
    XCTAssertEqual(
      payload.image, AgentImage(data: Data([0xFF, 0xD8, 0x00]), mimeType: "image/jpeg"))
  }

  func testErrorsTravelAsStructuredFailures() throws {
    let path = socketPath()
    let server = AgentSocketServer(path: path) { request in
      AgentResponse(
        id: request.id,
        outcome: .failure(
          AgentError(code: "stale_revision", message: "changed", details: ["revision": "abc"])))
    }
    try server.start()
    defer { server.stop() }

    let response = try AgentSocketClient(path: path, timeout: 5).send(
      AgentRequest(id: 1, tool: "maple_undo", arguments: [:]))

    guard case .failure(let error) = response.outcome else { return XCTFail("expected failure") }
    XCTAssertEqual(
      error, AgentError(code: "stale_revision", message: "changed", details: ["revision": "abc"]))
  }

  func testSocketIsOwnerOnlyAndRemovedOnStop() throws {
    let path = socketPath()
    let server = AgentSocketServer(path: path) {
      AgentResponse(id: $0.id, outcome: .success(AgentPayload(result: nil)))
    }
    try server.start()
    let mode = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? Int
    XCTAssertEqual(mode, 0o600)
    server.stop()
    XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    XCTAssertThrowsError(
      try AgentSocketClient(path: path, timeout: 1).send(
        AgentRequest(id: 1, tool: "x", arguments: [:])))
  }

  func testSecondServerRefusesALiveSocketButReplacesAStaleOne() throws {
    let path = socketPath()
    let first = AgentSocketServer(path: path) {
      AgentResponse(id: $0.id, outcome: .success(AgentPayload(result: 1)))
    }
    try first.start()
    let second = AgentSocketServer(path: path) {
      AgentResponse(id: $0.id, outcome: .success(AgentPayload(result: 2)))
    }
    XCTAssertThrowsError(try second.start()) { error in
      XCTAssertEqual(error as? AgentSocketError, .addressInUse(path))
    }
    first.stop()

    FileManager.default.createFile(atPath: path, contents: Data())
    try second.start()
    defer { second.stop() }
    let response = try AgentSocketClient(path: path, timeout: 5).send(
      AgentRequest(id: 3, tool: "x", arguments: [:]))
    XCTAssertEqual(try response.outcome.get().result, 2)
  }

  func testMalformedLineGetsAStructuredErrorAndConnectionStaysUsable() throws {
    let path = socketPath()
    let server = AgentSocketServer(path: path) {
      AgentResponse(id: $0.id, outcome: .success(AgentPayload(result: "ok")))
    }
    try server.start()
    defer { server.stop() }

    let fd = try UnixSocket.connect(path)
    defer { close(fd) }
    try UnixSocket.writeAll(fd, Data("not json\n".utf8))
    try UnixSocket.writeLine(fd, AgentRequest(id: 9, tool: "x", arguments: [:]).json)
    var reader = LineReader(fd: fd)
    let first = try XCTUnwrap(reader.nextLine().flatMap { try JSONValue.decode($0) }).flatMap(
      AgentResponse.init(json:))
    let second = try XCTUnwrap(reader.nextLine().flatMap { try JSONValue.decode($0) }).flatMap(
      AgentResponse.init(json:))
    guard case .failure(let error) = first?.outcome else { return XCTFail("expected failure") }
    XCTAssertEqual(error.code, "malformed_request")
    XCTAssertEqual(second?.id, 9)
  }

  func testPathLongerThanSunPathIsRejected() {
    let path = "/tmp/" + String(repeating: "x", count: 120)
    XCTAssertThrowsError(try UnixSocket.makeAddress(path)) { error in
      XCTAssertEqual(error as? AgentSocketError, .pathTooLong(path))
    }
  }

  func testDefaultPathFitsSunPath() throws {
    XCTAssertNoThrow(try UnixSocket.makeAddress(AgentSocketLocation.defaultPath()))
    XCTAssertTrue(
      AgentSocketLocation.defaultPath().hasSuffix(
        "Library/Group Containers/group.app.justmaple.aperture/maple-agent.sock"))
  }
}

final class JSONValueTests: XCTestCase {
  func testEncodingIsCompactSortedAndPreservesIntegers() throws {
    let value: JSONValue = ["b": 2, "a": [1.5, true, nil, "s/t"]]
    let line = String(decoding: try value.encodedLine(), as: UTF8.self)
    XCTAssertEqual(line, #"{"a":[1.5,true,null,"s/t"],"b":2}"#)
    XCTAssertEqual(try JSONValue.decode(Data(line.utf8)), value)
  }
}
