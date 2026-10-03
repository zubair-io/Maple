// swift-tools-version: 5.10
// MapleMCP — lets a local AI agent drive the running Maple editor.
//
//   MapleAgentWire  newline-delimited JSON over a Unix socket in the app-group
//                   container. MapleCore links it to serve the live editor.
//   MapleMCPServer  MCP JSON-RPC dispatch and the tool catalog; forwards each
//                   tool call to the app over MapleAgentWire.
//   maple-mcp       stdio executable that MCP clients (Claude Desktop) launch.
//
// No dependency on MapleCore or RawPipeline: the bridge builds and tests
// without the native xcframework.

import PackageDescription

let package = Package(
  name: "MapleMCP",
  platforms: [
    .macOS(.v14),
    .iOS(.v17),
    .tvOS(.v17),
  ],
  products: [
    .library(name: "MapleAgentWire", targets: ["MapleAgentWire"]),
    .library(name: "MapleMCPServer", targets: ["MapleMCPServer"]),
    .executable(name: "maple-mcp", targets: ["maple-mcp"]),
  ],
  targets: [
    .target(name: "MapleAgentWire"),
    .target(name: "MapleMCPServer", dependencies: ["MapleAgentWire"]),
    .executableTarget(name: "maple-mcp", dependencies: ["MapleMCPServer"]),
    .testTarget(
      name: "MapleMCPTests",
      dependencies: ["MapleAgentWire", "MapleMCPServer"]
    ),
  ]
)
