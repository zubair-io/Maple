// swift-tools-version: 5.10
// Maple native — iOS/Mac/iPad Swift package skeleton.
//
// Scope per docs/spec/12-maple-apps-spec.md § 09:
//   - SwiftUI three-column shell on Mac/iPad, bottom-tab single-column on iPhone.
//   - Consume raw-core via the RawPipeline.xcframework (built from src/raw-pipeline/raw-ffi).
//   - Source adapters: PhotoKit, filesystem (security-scoped bookmarks), SMB (AMSMB2).
//   - .maple/ folder-cache reuse across Maple Hosted / Self Hosted / native.
//
// Current state: Package.swift + empty targets. xcframework import and
// SwiftUI views are slice-10c work.

import PackageDescription

let package = Package(
    name: "Maple",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    products: [
        .library(name: "MapleCore", targets: ["MapleCore"]),
        .executable(name: "MapleApp", targets: ["MapleApp"]),
    ],
    targets: [
        // MapleCore — Swift side of the photo pipeline. Wraps the
        // RawPipeline.xcframework (from src/raw-pipeline/raw-ffi) and provides
        // EditSession / ImageEditPipeline / XMPSidecarStore per spec § 00 and
        // docs/spec/01-data-model.md.
        //
        // xcframework dependency is commented out until the build script exists
        // that compiles raw-ffi for aarch64-apple-ios, aarch64-apple-ios-sim,
        // aarch64-apple-macos, x86_64-apple-macos and bundles them as
        // RawPipeline.xcframework. Cbindgen-generated header lands in the
        // xcframework's Headers/ dir.
        .target(
            name: "MapleCore",
            dependencies: []
            // dependencies: [.byNameItem(name: "RawPipeline", condition: nil)]
        ),
        // .binaryTarget(name: "RawPipeline", path: "Frameworks/RawPipeline.xcframework"),

        .executableTarget(
            name: "MapleApp",
            dependencies: ["MapleCore"],
            resources: [.process("../../Resources")]
        ),

        .testTarget(name: "MapleCoreTests", dependencies: ["MapleCore"]),
    ]
)
