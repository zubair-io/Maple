// swift-tools-version: 5.10
// MapleMCP — lets a local AI agent drive the running Maple editor.
//
//   MapleAgentWire  newline-delimited JSON over a Unix socket in the app-group
//                   container. MapleCore links it to serve the live editor.
//   MapleMCPServer  MCP JSON-RPC dispatch and the tool catalog; forwards each
//                   tool call to the app over MapleAgentWire.
//   MapleMCPHTTP   app-owned loopback Streamable HTTP server (SwiftNIO).
//   maple-mcp       developer/qualification stdio executable.
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
    .library(name: "MapleMCPHTTP", targets: ["MapleMCPHTTP"]),
    .executable(name: "maple-mcp", targets: ["maple-mcp"]),
  ],
  dependencies: [
    .package(url: "https://github.com/apple/swift-nio.git", from: "2.100.0")
  ],
  targets: [
    .target(name: "MapleAgentWire"),
    .target(name: "MapleMCPServer", dependencies: ["MapleAgentWire"]),
    .target(
      name: "MapleMCPHTTP",
      dependencies: [
        "MapleMCPServer", "MapleAgentWire",
        .product(name: "NIOCore", package: "swift-nio"),
        .product(name: "NIOPosix", package: "swift-nio"),
        .product(name: "NIOHTTP1", package: "swift-nio"),
      ],
      resources: [.copy("Resources/Maple.mcpb")]
    ),
    .executableTarget(name: "maple-mcp", dependencies: ["MapleMCPServer"]),
    .testTarget(
      name: "MapleMCPTests",
      dependencies: ["MapleAgentWire", "MapleMCPServer", "MapleMCPHTTP"]
    ),
  ]
)
