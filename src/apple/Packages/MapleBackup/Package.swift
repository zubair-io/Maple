// swift-tools-version: 5.10
// MapleBackup — device-side PhotoKit backup engine.
//
// This package is consumed three ways:
//   1. By MapleCore (Task 2.13 — PhotoKitSource.writeXMP rewrite).
//   2. By MapleApp (Phase 3 Task 3.1 — EngineHost).
//   3. By MapleBackupAgent (Phase 3 Task 3.10 — macOS LaunchAgent).
//
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md.

import PackageDescription

let package = Package(
    name: "MapleBackup",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    products: [
        .library(name: "MapleBackup", targets: ["MapleBackup"]),
    ],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift.git", from: "6.27.0"),
    ],
    targets: [
        .target(
            name: "MapleBackup",
            dependencies: [.product(name: "GRDB", package: "GRDB.swift")]
        ),
        .testTarget(
            name: "MapleBackupTests",
            dependencies: ["MapleBackup"]
        ),
    ]
)
