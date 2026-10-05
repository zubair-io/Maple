import Darwin
import Foundation
import MapleAgentWire
import MapleMCPHTTP
import XCTest

final class MCPHTTPServerTests: XCTestCase {
  private let token = "transport-test-token"

  func testSetupPromptIncludesActualConnectionAndClientInstructions() throws {
    let url = try XCTUnwrap(URL(string: "http://127.0.0.1:49158/mcp"))
    let prompt = try MCPClientSetup.prompt(url: url, token: token)
    XCTAssertTrue(prompt.contains("Server URL: \(url.absoluteString)"))
    XCTAssertTrue(prompt.contains("Authorization header: Bearer \(token)"))
    XCTAssertTrue(prompt.contains("[mcp_servers.maple]"))
    XCTAssertTrue(prompt.contains("~/.codex/config.toml"))
    XCTAssertTrue(prompt.contains("~/.cursor/mcp.json"))
    let cursorSection = try XCTUnwrap(prompt.components(separatedBy: "~/.cursor/mcp.json:\n").last)
      .components(separatedBy: "\n\nFor Claude Desktop")[0]
    let cursor = try JSONValue.decode(Data(cursorSection.utf8))
    XCTAssertEqual(cursor["mcpServers"]?["maple"]?["url"], .string(url.absoluteString))
    XCTAssertEqual(
      cursor["mcpServers"]?["maple"]?["headers"]?["Authorization"], .string("Bearer \(token)"))
    XCTAssertTrue(prompt.contains(try XCTUnwrap(MCPClientSetup.claudeExtensionURL).path))
    XCTAssertTrue(prompt.contains("cloud connectors cannot reach localhost"))
    XCTAssertTrue(prompt.contains("Preserve other servers and settings"))
    XCTAssertTrue(prompt.contains("list Maple's tools"))
  }

  private func withServer(_ body: (MCPHTTPServer, URL) async throws -> Void) async throws {
    let server = MCPHTTPServer { request in
      AgentResponse(
        id: request.id, outcome: .success(AgentPayload(result: ["tool": .string(request.tool)])))
    }
    let url = try await server.start(port: 0, token: token)
    do {
      try await body(server, url)
      await server.stop()
    } catch {
      await server.stop()
      throw error
    }
  }

  private func request(_ method: String, params: JSONValue = [:]) -> JSONValue {
    ["jsonrpc": "2.0", "id": "request-1", "method": .string(method), "params": params]
  }

  private func post(
    _ url: URL, body: Data, headers: [String: String] = [:], method: String = "POST"
  ) async throws -> (Int, Data) {
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.httpBody = body
    request.timeoutInterval = 5
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
    request.setValue("2025-11-25", forHTTPHeaderField: "MCP-Protocol-Version")
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    let (data, response) = try await URLSession.shared.data(for: request)
    return (try XCTUnwrap(response as? HTTPURLResponse).statusCode, data)
  }

  func testInitializeListCallAndNotificationOverHTTP() async throws {
    try await withServer { _, url in
      XCTAssertEqual(url.host, "127.0.0.1")
      let initialized = try await post(
        url,
        body: request("initialize", params: ["protocolVersion": "2025-11-25", "capabilities": [:]])
          .encodedLine())
      XCTAssertEqual(initialized.0, 200)
      XCTAssertEqual(
        try JSONValue.decode(initialized.1)["result"]?["protocolVersion"], "2025-11-25")
      let listed = try await post(url, body: request("tools/list").encodedLine())
      XCTAssertEqual(listed.0, 200)
      XCTAssertNotNil(try JSONValue.decode(listed.1)["result"]?["tools"])
      let called = try await post(
        url,
        body: request("tools/call", params: ["name": "maple_get_active_photo", "arguments": [:]])
          .encodedLine())
      XCTAssertEqual(called.0, 200)
      XCTAssertEqual(
        try JSONValue.decode(called.1)["result"]?["structuredContent"]?["tool"],
        "maple_get_active_photo")
      let notification: JSONValue = ["jsonrpc": "2.0", "method": "notifications/initialized"]
      let notified = try await post(url, body: notification.encodedLine())
      XCTAssertEqual(notified.0, 202)
      XCTAssertTrue(notified.1.isEmpty)
    }
  }

  func testAuthenticationOriginHostAndMediaTypeAreRequired() async throws {
    try await withServer { _, url in
      let body = try request("tools/list").encodedLine()
      let rejected: [([String: String], Int)] = [
        (["Authorization": ""], 401), (["Authorization": "Bearer wrong"], 401),
        (["Origin": "https://attacker.example"], 403), (["Origin": "null"], 403),
        (["Host": "attacker.example"], 403), (["Content-Type": "text/plain"], 415),
        (["Accept": "application/json"], 406), (["MCP-Protocol-Version": "1900-01-01"], 400),
      ]
      for (headers, status) in rejected {
        let reply = try await post(url, body: body, headers: headers)
        XCTAssertEqual(reply.0, status, "\(headers)")
      }
      let allowed = try await post(
        url, body: body, headers: ["Origin": "http://127.0.0.1:\(try XCTUnwrap(url.port))"])
      XCTAssertEqual(allowed.0, 200)
      let get = try await post(url, body: Data(), method: "GET")
      XCTAssertEqual(get.0, 405)
      let missing = try await post(url.appendingPathComponent("missing"), body: body)
      XCTAssertEqual(missing.0, 404)
    }
  }

  func testBadBodiesAndOversizedRequestsAreRejected() async throws {
    try await withServer { _, url in
      for body in [Data("{".utf8), Data("[]".utf8), Data("{\"id\":1,\"method\":\"ping\"}".utf8)] {
        let reply = try await post(url, body: body)
        XCTAssertEqual(reply.0, 400)
        XCTAssertNotNil(try JSONValue.decode(reply.1)["error"])
      }
      let port = try XCTUnwrap(url.port)
      let response = try await Task.detached {
        try HTTPRawProbe.exchange(
          port: port,
          request:
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nAuthorization: Bearer transport-test-token\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: 1048577\r\n\r\n"
        )
      }.value
      XCTAssertTrue(response.hasPrefix("HTTP/1.1 413"), response)
    }
  }

  func testModernMetadataMatchesHTTPHeaders() async throws {
    try await withServer { _, url in
      let params: JSONValue = ["_meta": ["io.modelcontextprotocol/protocolVersion": "2026-07-28"]]
      let headers = ["MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover"]
      let discover = try await post(
        url, body: request("server/discover", params: params).encodedLine(), headers: headers)
      XCTAssertEqual(discover.0, 200)
      XCTAssertEqual(try JSONValue.decode(discover.1)["result"]?["resultType"], "complete")
      let mismatch = try await post(
        url, body: request("tools/list", params: params).encodedLine(), headers: headers)
      XCTAssertEqual(mismatch.0, 400)
      XCTAssertEqual(try JSONValue.decode(mismatch.1)["error"]?["code"], -32020)
      let callParams: JSONValue = [
        "name": "maple_get_active_photo", "arguments": [:], "_meta": params["_meta"]!,
      ]
      let missingName = try await post(
        url, body: request("tools/call", params: callParams).encodedLine(),
        headers: ["MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call"])
      XCTAssertEqual(missingName.0, 400)
      let name = "=?base64?\(Data("maple_get_active_photo".utf8).base64EncodedString())?="
      let called = try await post(
        url, body: request("tools/call", params: callParams).encodedLine(),
        headers: [
          "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": name,
        ])
      XCTAssertEqual(called.0, 200)
      let unknown = try await post(
        url, body: request("bogus", params: params).encodedLine(),
        headers: ["MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "bogus"])
      XCTAssertEqual(unknown.0, 404)
    }
  }

  func testPortConflictAndRestartAfterShutdown() async throws {
    try await withServer { server, url in
      let other = MCPHTTPServer { _ in throw CancellationError() }
      do {
        _ = try await other.start(port: UInt16(try XCTUnwrap(url.port)), token: token)
        XCTFail("A second listener must not steal the port")
      } catch {
        // Bind conflict is surfaced to Settings.
      }
      await other.stop()
      await server.stop()
      let restarted = try await server.start(port: UInt16(try XCTUnwrap(url.port)), token: token)
      XCTAssertEqual(restarted, url)
      await server.stop()
      do {
        _ = try await post(url, body: request("ping").encodedLine())
        XCTFail("Disabled MCP still accepted a connection")
      } catch {
        // No listener after stop.
      }
    }
  }

  func testStopClosesIdleAndInFlightConnections() async throws {
    let started = expectation(description: "tool is awaiting work")
    let cancelled = expectation(description: "tool work is cancelled")
    let server = MCPHTTPServer { _ in
      started.fulfill()
      do {
        try await Task.sleep(for: .seconds(30))
        XCTFail("Disabled server let work finish")
      } catch { cancelled.fulfill() }
      throw CancellationError()
    }
    let url = try await server.start(port: 0, token: token)
    let idle = try HTTPRawProbe.connect(port: XCTUnwrap(url.port))
    defer { Darwin.close(idle) }
    let body = try request("tools/call", params: ["name": "maple_get_active_photo"]).encodedLine()
    let pending = Task { try await post(url, body: body) }
    await fulfillment(of: [started], timeout: 3)
    await server.stop()
    await fulfillment(of: [cancelled], timeout: 3)
    var byte: UInt8 = 0
    XCTAssertEqual(Darwin.recv(idle, &byte, 1, 0), 0, "Idle socket was not closed")
    do {
      _ = try await pending.value
      XCTFail("Closed request unexpectedly completed")
    } catch {
      // Shutdown terminates the response connection.
    }
  }

  func testBundledClaudeAdapterConnectsToTheSameServer() async throws {
    try await withServer { _, url in
      let bundle = try XCTUnwrap(MCPClientSetup.claudeExtensionURL)
      XCTAssertGreaterThan(try Data(contentsOf: bundle).count, 0)
      let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appending(
          path:
            "ClaudeDesktop/server/index.js")
      let messages = [
        request("initialize", params: ["protocolVersion": "2025-06-18"]), request("tools/list"),
        request("tools/call", params: ["name": "maple_get_active_photo", "arguments": [:]]),
      ]
      let input = try messages.reduce(into: Data()) {
        $0.append(try $1.encodedLine())
        $0.append(0x0A)
      }
      let token = token
      let output = try await Task.detached {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", script.path]
        process.environment = ProcessInfo.processInfo.environment.merging([
          "MAPLE_MCP_URL": url.absoluteString, "MAPLE_MCP_TOKEN": token,
        ]) { _, new in new }
        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        try stdin.fileHandleForWriting.write(contentsOf: input)
        try stdin.fileHandleForWriting.close()
        let output = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        XCTAssertEqual(
          process.terminationStatus, 0,
          String(decoding: stderr.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self))
        return output
      }.value
      let replies = try output.split(separator: 0x0A).map { try JSONValue.decode(Data($0)) }
      XCTAssertEqual(replies.count, 3)
      XCTAssertEqual(replies.first?["result"]?["protocolVersion"], "2025-06-18")
      XCTAssertEqual(
        replies.last?["result"]?["structuredContent"]?["tool"], "maple_get_active_photo")
    }
  }
}
