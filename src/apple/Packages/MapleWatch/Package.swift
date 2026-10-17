// swift-tools-version: 6.1
import PackageDescription

let package = Package(
  name: "MapleWatch",
  platforms: [.watchOS(.v10)],
  products: [.library(name: "MapleWatch", targets: ["MapleWatch"])],
  dependencies: [.package(path: "../MapleCore")],
  targets: [
    .target(
      name: "MapleWatch",
      dependencies: [
        .product(name: "MapleCloudKit", package: "MapleCore")
      ]),
    .testTarget(
      name: "MapleWatchTests",
      dependencies: ["MapleWatch", .product(name: "MapleCloudKit", package: "MapleCore")]),
  ],
  swiftLanguageModes: [.v5]
)
