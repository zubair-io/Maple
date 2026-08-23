// swift-tools-version: 5.10
// MapleUI — the shared, cross-platform Maple design system (Apple package).
//
// Deliberately dependency-free: no MapleCore import, no third-party SPM
// packages. Real sibling apps (SugarMaple, MapleRecorder, MapleBricks) are
// meant to consume this package directly, so it cannot pull in anything
// Maple-app-specific. See docs/superpowers/specs/2026-08-22-maple-ui-design-system-design.md §3.
//
// Contracts: docs/design/maple-ui/components/*.md. Catalog:
// docs/unified-component-catalog.md.

import PackageDescription

let package = Package(
    name: "MapleUI",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    products: [
        .library(name: "MapleUI", targets: ["MapleUI"]),
    ],
    targets: [
        .target(
            name: "MapleUI"
        ),
        .testTarget(
            name: "MapleUITests",
            dependencies: ["MapleUI"]
        ),
    ]
)
