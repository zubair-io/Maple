#if os(macOS)
  import Foundation
  import Darwin

  /// #4140: actual executable transport, bounded output and deadline. Each
  /// invocation initializes an MCP session before issuing the tool request.
  enum MCPStdioQualification {
    static func request(executable: URL, socket: String, tool: String, arguments: Data) throws
      -> Data
    {
      let process = Process()
      process.executableURL = executable
      process.arguments = ["--socket", socket]
      let input = Pipe()
      let output = Pipe()
      let errors = Pipe()
      process.standardInput = input
      process.standardOutput = output
      process.standardError = errors
      try process.run()
      defer {
        try? input.fileHandleForWriting.close()
        try? output.fileHandleForReading.close()
        try? errors.fileHandleForReading.close()
        if process.isRunning { process.terminate() }
      }
      let object = try JSONSerialization.jsonObject(with: arguments)
      let messages: [[String: Any]] = [
        [
          "jsonrpc": "2.0", "id": 1, "method": "initialize",
          "params": ["protocolVersion": "2025-11-25"],
        ],
        ["jsonrpc": "2.0", "method": "notifications/initialized"],
        [
          "jsonrpc": "2.0", "id": 2, "method": "tools/call",
          "params": ["name": tool, "arguments": object],
        ],
      ]
      for message in messages {
        var data = try JSONSerialization.data(withJSONObject: message)
        data.append(10)
        try input.fileHandleForWriting.write(contentsOf: data)
      }
      try input.fileHandleForWriting.close()
      let deadline = Date().addingTimeInterval(30)
      var received = Data()
      var descriptor = pollfd(
        fd: output.fileHandleForReading.fileDescriptor, events: Int16(POLLIN), revents: 0)
      while Date() < deadline {
        let result = poll(&descriptor, 1, 100)
        if result < 0 { throw CocoaError(.fileReadUnknown) }
        if result == 0 { continue }
        var buffer = [UInt8](repeating: 0, count: 4096)
        let count = read(descriptor.fd, &buffer, buffer.count)
        if count < 0 { throw CocoaError(.fileReadUnknown) }
        if count == 0 {
          for line in received.split(separator: 10) {
            guard let reply = try JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
              (reply["id"] as? Int) == 2,
              let payload = reply["result"] as? [String: Any]
            else { continue }
            if payload["isError"] as? Bool == true {
              throw MCPQualificationError.tool(try JSONSerialization.data(withJSONObject: payload))
            }
            return try JSONSerialization.data(withJSONObject: payload)
          }
          throw MCPQualificationError.missingReply
        }
        received.append(contentsOf: buffer.prefix(count))
        guard received.count <= 2 * 1024 * 1024 else { throw MCPQualificationError.oversized }
      }
      throw MCPQualificationError.timeout
    }
  }

  enum MCPQualificationError: Error {
    case timeout, oversized, missingReply
    case tool(Data)
  }

#endif
