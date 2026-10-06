// swift-tools-version: 6.1
import PackageDescription

let package = Package(
  name: "MapleRemovalLab", platforms: [.macOS(.v14)],
  products: [.executable(name: "MapleRemovalLab", targets: ["RemovalLab"])],
  targets: [.executableTarget(name: "RemovalLab")], swiftLanguageModes: [.v5]
)
