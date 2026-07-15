// swift-tools-version: 6.1
// Maple native — local Swift package hosting the shared domain core.
//
// Tools version is 6.1 (bumped from 5.10) because swift-otel is a
// tools-version-6.1 package and its per-dependency *trait* selection
// (we enable only `OTLPHTTP`, see the dependency below) is a SwiftPM 6.1
// feature. The MapleCore target stays in the Swift 5 language mode
// (`swiftLanguageModes: [.v5]`) so the existing sources don't have to
// adopt Swift 6 strict-concurrency in this change.
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
        .package(path: "../MapleBackup"),
        // swift-otel — OpenTelemetry SDK. Pinned to 1.2.1 (latest stable as of
        // 2026-05-30). We enable ONLY the `OTLPHTTP` trait — Maple exports
        // OTLP/HTTP to a self-hosted SigNoz, never OTLP/gRPC. Disabling the
        // default traits drops the grpc-swift-2 dependency tree, which also
        // keeps the deployment floor at macOS 14 / iOS 17 (grpc-swift-2 needs
        // macOS 15 / iOS 18). The `Observability/` subsystem is the only
        // consumer.
        .package(
            url: "https://github.com/swift-otel/swift-otel.git",
            exact: "1.2.1",
            traits: ["OTLPHTTP"]
        ),
    ],
    targets: [
        .target(
            name: "MapleCore",
            dependencies: [
                "RawPipeline",
                .product(name: "AMSMB2", package: "AMSMB2"),
                .product(name: "MapleBackup", package: "MapleBackup"),
                .product(name: "OTel", package: "swift-otel"),
            ],
            resources: [
                // .metal files are CoreImage CIKernel sources, NOT standard
                // Metal libraries. They are read verbatim at runtime via
                // Bundle.module and compiled through CIKernel(source:) —
                // Xcode must not attempt a build-time Metal compile (would
                // fail: these use the coreimage:: namespace). `.copy` is
                // correct here; `.process` triggers the failing compile.
                .copy("Metal"),
                // Canonical built-in presets (#1115) — the SAME file the
                // web mirrors (parity-pinned by the API-side
                // builtin-presets-parity test). Read via Bundle.module in
                // PresetStore.
                .copy("Resources/builtin-presets.json"),
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
            dependencies: [
                "MapleCore",
                .product(name: "MapleBackup", package: "MapleBackup"),
            ],
            resources: [
                .copy("Fixtures/auth-contract.json"),
                .copy("Fixtures/preview-path-contract.json"),
            ]
        ),
    ],
    // Tools version is 6.1 (for swift-otel's per-dependency trait selection),
    // but the existing MapleCore + test sources were written for Swift 5.10.
    // Pin the language mode to v5 package-wide so the 6.1 default (Swift 6
    // strict concurrency) doesn't break them — this change only adds the
    // OTel wiring, it doesn't migrate the package to Swift 6.
    swiftLanguageModes: [.v5]
)
