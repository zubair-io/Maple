// swift-tools-version: 5.10
// Maple native — local Swift package hosting the shared domain core.
//
// This package is consumed two ways:
//   1. By Maple.xcodeproj (the App Store target) as a local package reference.
//   2. Standalone via `swift build` / `swift test` for CI and headless runs.
//
// Scope per docs/spec/12-maple-apps-spec.md § 09:
//   - MapleCore wraps the RawPipeline.xcframework (built from raw-ffi) and
//     exposes the EditSession / ImageEditPipeline / XMPSidecarStore surface.
//   - The Xcode App target in ../.. owns the SwiftUI shell, entitlements,
//     and asset catalog; it depends on MapleCore via this package.
//   - No executable product here — the app is an Xcode target, not SPM.

import PackageDescription

let package = Package(
    name: "MapleCore",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    products: [
        .library(name: "MapleCore", targets: ["MapleCore"]),
    ],
    dependencies: [
        // AMSMB2 — Swift SMB 2/3 client (MIT license; review before App Store submission).
        .package(url: "https://github.com/amosavian/AMSMB2.git", from: "4.0.0"),
    ],
    targets: [
        .target(
            name: "MapleCore",
            dependencies: [
                "RawPipeline",
                .product(name: "AMSMB2", package: "AMSMB2"),
            ],
            resources: [
                // .metal files are CoreImage CIKernel sources, NOT standard
                // Metal libraries. They are read verbatim at runtime via
                // Bundle.module and compiled through CIKernel(source:) —
                // Xcode must not attempt a build-time Metal compile (would
                // fail: these use the coreimage:: namespace). `.copy` is
                // correct here; `.process` triggers the failing compile.
                .copy("Metal"),
            ]
        ),
        // Binary dependency — RawPipeline.xcframework lives outside the package
        // so the Xcode project can link the same binary directly.
        .binaryTarget(
            name: "RawPipeline",
            path: "../../Frameworks/RawPipeline.xcframework"
        ),
        .testTarget(
            name: "MapleCoreTests",
            dependencies: ["MapleCore"]
        ),
    ]
)
