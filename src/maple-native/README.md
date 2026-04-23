# Maple native

Swift iOS/Mac/iPad app. Consumes `raw-core` via the `RawPipeline.xcframework` built from `src/raw-pipeline/raw-ffi`. Spec: `docs/spec/12-maple-apps-spec.md` § 09 + `docs/spec/00-overview.md` "Apple (Swift)".

## Current state (2026-04-22)

Swift-package scaffold only. `swift build` produces a trivial SwiftUI app that imports `MapleCore` (stub) and prints a version string. No xcframework, no views, no source adapters.

## What's built

- `Package.swift` — Swift Package Manager manifest. Two targets (`MapleApp` executable, `MapleCore` library) + a tests target. Platforms: macOS 14, iOS 17 (conservative floors for the scaffold; production floors are macOS 26.3 / iOS 26.4 per spec § 00).
- `Sources/MapleApp/MapleApp.swift` — `@main` SwiftUI App with a placeholder view.
- `Sources/MapleCore/MapleCore.swift` — enum `MapleCore` with a `version()` stub.
- `Tests/MapleCoreTests/MapleCoreTests.swift` — one smoke test.

## What's NOT built (see slice 10c plan)

- **`RawPipeline.xcframework` import.** Needs a build script that compiles `src/raw-pipeline/raw-ffi` for 4 targets (aarch64-apple-ios, aarch64-apple-ios-sim, aarch64-apple-macos, x86_64-apple-macos) and bundles them as an xcframework with a cbindgen-generated `RawPipeline.h`. Then `Package.swift`'s `.binaryTarget` line is uncommented and `MapleCore` depends on it.
- **`EditSession`, `ImageEditPipeline`, `XMPSidecarStore`** per spec § 01 / § 02. EditSession is the per-image transient state; ImageEditPipeline wraps CIFilter + custom Metal kernels (`SceneToneControls`, `SceneVibrance`, `AgXViewTransform`); XMPSidecarStore is a Swift actor with a debounced writer.
- **Source adapters.** `FilesystemSource` (security-scoped bookmarks), `PhotoKitSource`, `SMBSource` (AMSMB2).
- **Metal + CoreImage render path.** CIContext on top of MTLDevice; 11-stage CIFilter chain with two custom `CIColorKernel`s.
- **SwiftUI shell.** AppShell (three-column split on Mac/iPad, bottom-tab collapse on iPhone), Browse grid, FullImage view, DetailPanel with Info + Develop tabs. UI design is defined by `src/maple-hosted/` prototype (port the look-and-feel, not the React structure).
- **`.maple/` folder-cache reuse.** Shared format with Maple Hosted and Self Hosted; a Mac that indexes an SMB share makes thumbs an iPad can reuse.

## Run the stub

```bash
cd /Users/riabuz/Projects/_Maple/src/maple-native
swift test          # runs MapleCoreTests — one smoke test
swift build         # builds the MapleApp executable (no UI yet beyond a placeholder view)
swift run MapleApp  # opens a window on macOS with "Maple / MapleCore 0.1.0 — stub"
```

## Implementation plan

See `docs/superpowers/plans/2026-04-22-slice-10c-maple-native.md`.
