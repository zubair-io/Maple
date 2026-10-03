import Foundation
import MapleAgentWire
import MapleMCPServer

// maple-mcp: an MCP server on stdio that forwards tool calls to the running
// Maple app. Usage: maple-mcp [--socket PATH]

var socketPath = AgentSocketLocation.defaultPath()
var arguments = CommandLine.arguments.dropFirst()
while let flag = arguments.popFirst() {
  switch flag {
  case "--socket":
    guard let path = arguments.popFirst() else {
      FileHandle.standardError.write(Data("--socket requires a path\n".utf8))
      exit(64)
    }
    socketPath = path
  case "--version":
    print("maple-mcp \(MCPDispatcher.serverVersion)")
    exit(0)
  default:
    FileHandle.standardError.write(Data("usage: maple-mcp [--socket PATH]\n".utf8))
    exit(64)
  }
}

let client = AgentSocketClient(path: socketPath)
let dispatcher = MCPDispatcher(forward: client.send)
let stdout = FileHandle.standardOutput

while let line = readLine(strippingNewline: true) {
  guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
  let reply: JSONValue?
  if let message = try? JSONValue.decode(Data(line.utf8)) {
    reply = dispatcher.handle(message)
  } else {
    reply = ["jsonrpc": "2.0", "id": nil, "error": ["code": -32700, "message": "Parse error"]]
  }
  guard let reply, var data = try? reply.encodedLine() else { continue }
  data.append(0x0A)
  stdout.write(data)
}
