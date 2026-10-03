import Foundation
import XCTest

@testable import MapleAgentWire

final class NumericWireTests: XCTestCase {
  func testRequestAndResponseIDsRequireExactlyRepresentableIntegers() {
    for value in [
      1e100, -1e100, .infinity, -.infinity, .nan, 1.5,
      Double(Int.max), Double(Int.min).nextDown,
    ] {
      XCTAssertNil(AgentRequest(json: ["id": .number(value), "tool": "x"]))
      XCTAssertNil(AgentResponse(json: ["id": .number(value), "result": [:]]))
      XCTAssertNil(
        AgentResponse(json: [
          "id": .number(value),
          "error": ["code": "test", "message": "test"],
        ]))
    }
    for value in [0, 1, -1, Int.min, Int(1) << 62] {
      let jsonID = JSONValue.number(Double(value))
      XCTAssertEqual(AgentRequest(json: ["id": jsonID, "tool": "x"])?.id, value)
      XCTAssertEqual(AgentResponse(json: ["id": jsonID, "result": [:]])?.id, value)
    }
  }

  func testJSONEncoderDoesNotNarrowHugeNumbersOrInt64Boundaries() throws {
    for value in [Double(Int64.max), Double(Int64.min), 1e100, -1e100] {
      let encoded = try JSONValue.number(value).encodedLine()
      XCTAssertEqual(try JSONValue.decode(encoded).numberValue, value)
    }
  }

  func testOversizedAndFractionalWireIDsDoNotKillTheServerOrConnection() throws {
    let path = "/tmp/mcp-number-\(UUID().uuidString.prefix(8)).sock"
    let server = AgentSocketServer(path: path) {
      AgentResponse(id: $0.id, outcome: .success(AgentPayload(result: "healthy")))
    }
    try server.start()
    defer { server.stop() }
    let fd = try UnixSocket.connect(path)
    defer { close(fd) }
    UnixSocket.setReceiveTimeout(fd, seconds: 5)
    for id in ["1e100", "-1e100", "1.5", "9223372036854775808"] {
      try UnixSocket.writeAll(fd, Data("{\"id\":\(id),\"tool\":\"x\"}\n".utf8))
    }
    try UnixSocket.writeLine(fd, AgentRequest(id: 9, tool: "x", arguments: [:]).json)
    var reader = LineReader(fd: fd)
    for _ in 0..<4 {
      let json = try JSONValue.decode(XCTUnwrap(reader.nextLine()))
      let response = try XCTUnwrap(AgentResponse(json: json))
      guard case .failure(let error) = response.outcome else { return XCTFail("expected failure") }
      XCTAssertEqual(error.code, "malformed_request")
    }
    let healthy = try XCTUnwrap(AgentResponse(json: JSONValue.decode(XCTUnwrap(reader.nextLine()))))
    XCTAssertEqual(healthy.id, 9)
    XCTAssertEqual(try healthy.outcome.get().result, "healthy")
  }
}
