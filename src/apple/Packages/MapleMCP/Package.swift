// swift-tools-version: 5.10
// MapleMCP — lets a local AI agent drive the running Maple editor.
//
//   MapleAgentWire  newline-delimited JSON over a Unix socket in the app-group
//                   container. MapleCore links it to serve the live editor.
//
// No dependency on MapleCore or RawPipeline, so it builds and tests without
// the native xcframework.

import PackageDescription

let package = Package(
  name: "MapleMCP",
  platforms: [
    .macOS(.v14),
    .iOS(.v17),
    .tvOS(.v17),
  ],
  products: [
    .library(name: "MapleAgentWire", targets: ["MapleAgentWire"])
  ],
  targets: [
    .target(name: "MapleAgentWire"),
    .testTarget(name: "MapleMCPTests", dependencies: ["MapleAgentWire"]),
  ]
)
