# Maple — Apple platforms

The Xcode project for Maple Exposure (macOS, iPadOS, iOS), Maple TV (tvOS), and the app extensions (File Provider, Quick Look, Widget, Backup agent). Swift + SwiftUI shell over the shared Rust core, which arrives as `Frameworks/RawPipeline.xcframework`.

Architecture, targets, packages, render path, and test harnesses are documented in [`docs/apple.md`](../../docs/apple.md). This file is only the quick start.

## Layout

```
Maple.xcodeproj/        Xcode project — shared schemes "Maple Exposure" and "MapleBackupAgent"
Maple/                  App target sources (SwiftUI views, deep links, backup UI)
Maple TV/               tvOS target
MapleBackupAgent/       Background backup agent
MapleFileProvider/      macOS File Provider extension
MapleFileProviderIOS/   iOS File Provider extension
MapleQuickLook/         Quick Look preview extension for File Provider items
MapleWidget/            Widget extension
MapleTests/             App-target unit tests
MapleUITests/           XCUITest visual harnesses (golden canvas, slider matrix, synthetic grey)
Packages/
  MapleCore/            Pipeline, sidecar, source adapters, caches, file operations
  MapleUI/              Design-system components (Mui* views), linked by the app target
  MapleBackup/          PhotoKit backup engine
Frameworks/             RawPipeline.xcframework (headers committed; static libs are built locally)
scripts/                build-xcframework.sh
ci_scripts/             Xcode Cloud post-clone bootstrap (installs Rust, builds the xcframework)
```

## First build

The static libraries inside the xcframework are gitignored. Build them once, then build with Xcode:

```bash
./src/apple/scripts/build-xcframework.sh
```

```bash
cd src/apple && xcodebuild -project Maple.xcodeproj -scheme "Maple Exposure" -destination 'platform=macOS' build
```

```bash
cd src/apple && xcodebuild -project Maple.xcodeproj -scheme "Maple Exposure" -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

The script defaults to a release build of the Rust core. Use `--debug` only for fast iteration when panorama performance does not matter.

## Tests

```bash
cd src/apple/Packages/MapleCore && swift test
```

The UI harnesses run through `xcodebuild test -only-testing:MapleUITests` and need the gitignored fixtures under `test-fixtures/raws/`; see [`docs/testing.md`](../../docs/testing.md).
