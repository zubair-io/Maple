import Foundation
import XCTest

@testable import MapleAgentWire

/// Runs the built `maple-mcp` executable as an MCP client would: JSON-RPC
/// lines on stdin, answers on stdout, with a real socket server standing in
/// for the app.
final class StdioBridgeTests: XCTestCase {
  private var executable: URL {
    Bundle(for: Self.self).bundleURL.deletingLastPathComponent().appendingPathComponent("maple-mcp")
  }

  private func run(_ messages: [JSONValue], socket: String) throws -> [JSONValue] {
    let process = Process()
    process.executableURL = executable
    process.arguments = ["--socket", socket]
    let input = Pipe()
    let output = Pipe()
    process.standardInput = input
    process.standardOutput = output
    try process.run()
    for message in messages {
      var line = try message.encodedLine()
      line.append(0x0A)
      input.fileHandleForWriting.write(line)
    }
    try input.fileHandleForWriting.close()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0)
    return try data.split(separator: 0x0A).map { try JSONValue.decode(Data($0)) }
  }

  func testFullSessionOverStdioReachesTheAppSocket() throws {
    XCTAssertTrue(
      FileManager.default.isExecutableFile(atPath: executable.path),
      "swift test builds maple-mcp beside the test bundle")
    let socket = "/tmp/mcp-stdio-\(UUID().uuidString.prefix(8)).sock"
    let server = AgentSocketServer(path: socket) { request in
      AgentResponse(
        id: request.id,
        outcome: .success(
          AgentPayload(result: ["tool": .string(request.tool), "revision": "abc"])))
    }
    try server.start()
    defer { server.stop() }

    let replies = try run(
      [
        [
          "jsonrpc": "2.0", "id": 1, "method": "initialize",
          "params": ["protocolVersion": "2025-11-25"],
        ],
        ["jsonrpc": "2.0", "method": "notifications/initialized"],
        ["jsonrpc": "2.0", "id": 2, "method": "tools/list"],
        [
          "jsonrpc": "2.0", "id": 3, "method": "tools/call",
          "params": ["name": "maple_get_active_photo", "arguments": [:]],
        ],
      ], socket: socket)

    XCTAssertEqual(replies.map { $0["id"] }, [1, 2, 3])
    XCTAssertEqual(replies[0]["result"]?["protocolVersion"], "2025-11-25")
    XCTAssertEqual(
      replies[2]["result"]?["structuredContent"],
      ["tool": "maple_get_active_photo", "revision": "abc"])
  }

  func testMissingAppYieldsToolErrorAndTheBridgeKeepsServing() throws {
    XCTAssertTrue(
      FileManager.default.isExecutableFile(atPath: executable.path),
      "swift test builds maple-mcp beside the test bundle")
    let replies = try run(
      [
        [
          "jsonrpc": "2.0", "id": 1, "method": "tools/call",
          "params": ["name": "maple_get_active_photo"],
        ],
        ["jsonrpc": "2.0", "id": 2, "method": "ping"],
      ], socket: "/tmp/mcp-absent-\(UUID().uuidString.prefix(8)).sock")
    XCTAssertEqual(replies.count, 2)
    XCTAssertEqual(replies[0]["result"]?["isError"], true)
    XCTAssertEqual(replies[1]["result"]?["resultType"], "complete")
  }
}
