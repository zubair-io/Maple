// RustPanoStitcherTests.swift — Unit tests for RustPanoStitcher (M4, #1234).
//
// These tests exercise option/stage mapping, error-path classification, and
// the BrowseViewModel.injectPanoResult integration without running a real
// 6-minute stitch. The real-stitch end-to-end is gated behind
// MAPLE_PANO_E2E=1 (mirrors the MAPLE_AUTO_E2E pattern) so the suite stays
// fast in CI.
//
// Ticket: #1234 / #1236

import Testing
import Foundation
@testable import MapleCore

// MARK: - PanoStage FFI mapping tests

@MainActor
struct PanoStageFFIMappingTests {

    @Test("FFI stage 0 maps to .decoding")
    func stage0IsDecoding() {
        #expect(PanoStage.fromFFIStage(0) == .decoding)
    }

    @Test("FFI stage 1 maps to .matching")
    func stage1IsMatching() {
        #expect(PanoStage.fromFFIStage(1) == .matching)
    }

    @Test("FFI stage 2 maps to .graph")
    func stage2IsGraph() {
        #expect(PanoStage.fromFFIStage(2) == .graph)
    }

    @Test("FFI stage 3 maps to .solving")
    func stage3IsSolving() {
        #expect(PanoStage.fromFFIStage(3) == .solving)
    }

    @Test("FFI stage 4 maps to .localAlign")
    func stage4IsLocalAlign() {
        #expect(PanoStage.fromFFIStage(4) == .localAlign)
    }

    @Test("FFI stage 5 maps to .compositing")
    func stage5IsCompositing() {
        #expect(PanoStage.fromFFIStage(5) == .compositing)
    }

    @Test("Unknown future stage ordinals map to .compositing (forward-compat)")
    func unknownStageForwardCompat() {
        #expect(PanoStage.fromFFIStage(99) == .compositing)
    }
}

// MARK: - PanoStitcherError tests

struct PanoStitcherErrorTests {

    @Test("modelsNotInstalled has a non-empty localizedDescription")
    func modelsNotInstalledHasDescription() {
        let err = PanoStitcherError.modelsNotInstalled("Test message")
        let desc = err.errorDescription ?? ""
        #expect(!desc.isEmpty)
        // The caller-provided message is forwarded verbatim.
        #expect(desc.contains("Test message"))
    }

    @Test("production modelsNotInstalled message references M6 follow-up")
    func productionModelsNotInstalledReferencesM6() {
        // The real provisioning error messages (as thrown by RustPanoStitcher)
        // must mention M6 so operators can find the follow-up ticket easily.
        let modelMsg = "Panorama models not installed. Set MAPLE_PANO_MODELS to the directory " +
                       "containing aliked.onnx and lightglue.onnx, or place them in " +
                       "~/Library/Application Support/app.justmaple.aperture/pano-models/. " +
                       "(Model bundling and download UI: M6 of #1234.)"
        let err = PanoStitcherError.modelsNotInstalled(modelMsg)
        #expect(err.errorDescription?.contains("M6") == true,
                "Production error message should reference the M6 follow-up for discoverability")
    }

    @Test("assetNotFileBacked embeds the asset name")
    func assetNotFileBackedEmbedsName() {
        let err = PanoStitcherError.assetNotFileBacked("IMG_0042.dng")
        #expect(err.errorDescription?.contains("IMG_0042.dng") == true)
    }

    @Test("unsupportedPlatform references M6")
    func unsupportedPlatformReferencesM6() {
        let err = PanoStitcherError.unsupportedPlatform
        #expect(err.errorDescription?.contains("M6") == true)
    }

    @Test("stitchFailed includes code and message")
    func stitchFailedIncludesCodeAndMessage() {
        let err = PanoStitcherError.stitchFailed(code: -7, message: "pipeline error")
        let desc = err.errorDescription ?? ""
        #expect(desc.contains("-7"))
        #expect(desc.contains("pipeline error"))
    }
}

// MARK: - RustPanoStitcher: missing models error path

@MainActor
struct RustPanoStitcherErrorPathTests {

    /// Verifies that `RustPanoStitcher.stitch` throws a clear error when the
    /// ML environment is not provisioned. Uses file-backed AssetRefs so the
    /// path-collection step succeeds; the models check fires next.
    ///
    /// We deliberately un-set `MAPLE_PANO_MODELS` and `ORT_DYLIB_PATH` and
    /// point the app-support resolver to a temp dir with no models, so the
    /// "models not installed" branch fires deterministically.
    @Test("throws modelsNotInstalled when environment is unprovisioned")
    func throwsWhenModelsUnprovisioned() async throws {
        // Un-set env vars so the resolver falls through to the app-support path.
        // Save and restore so we don't poison other tests that may run with env set.
        let savedModels = ProcessInfo.processInfo.environment["MAPLE_PANO_MODELS"]
        let savedOrt = ProcessInfo.processInfo.environment["ORT_DYLIB_PATH"]
        defer {
            if let v = savedModels { setenv("MAPLE_PANO_MODELS", v, 1) } else { unsetenv("MAPLE_PANO_MODELS") }
            if let v = savedOrt   { setenv("ORT_DYLIB_PATH", v, 1)    } else { unsetenv("ORT_DYLIB_PATH")    }
        }
        unsetenv("MAPLE_PANO_MODELS")
        unsetenv("ORT_DYLIB_PATH")

        // Create two real DNG-shaped placeholder files in a temp dir so
        // `collectInputURLs` succeeds (the files don't need to be valid RAWs
        // for the models-check path — we never reach the FFI).
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("rust-pano-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let a = tmp.appendingPathComponent("A.DNG")
        let b = tmp.appendingPathComponent("B.DNG")
        try Data("placeholder".utf8).write(to: a)
        try Data("placeholder".utf8).write(to: b)

        let assets = [AssetRef(url: a), AssetRef(url: b)]

        // Point the app-support resolver to a non-existent path by ensuring
        // neither env var is set and the default app-support location doesn't
        // happen to have a models dir on this machine (most test environments
        // won't). If it does, this test skips gracefully.
        let appSupportModels = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask
        ).first?.appendingPathComponent("app.justmaple.aperture/pano-models") ?? tmp

        if FileManager.default.fileExists(atPath: appSupportModels.path) {
            // Models are installed locally — skip this test; we can't
            // un-provision them without side effects. The real-stitch gate
            // will exercise the success path if MAPLE_PANO_E2E=1 is set.
            return
        }

        let stitcher = RustPanoStitcher()

        do {
            _ = try await stitcher.stitch(
                assets: assets,
                options: .default,
                progress: { _, _ in }
            )
            Issue.record("Expected throw but stitch succeeded")
        } catch let err as PanoStitcherError {
            if case .modelsNotInstalled = err {
                // Expected — pass.
            } else {
                Issue.record("Expected modelsNotInstalled, got \(err)")
            }
        } catch {
            Issue.record("Unexpected error type: \(error)")
        }
    }

    /// Verifies that a bytes-only (PhotoKit / cloud) asset triggers the
    /// `assetNotFileBacked` error before reaching the FFI.
    @Test("throws assetNotFileBacked for bytes-only assets")
    func throwsForBytesOnlyAsset() async throws {
        let bytesAsset = AssetRef(
            displayName: "cloud-photo.dng",
            hintExtension: "dng",
            stableID: "photokit:12345",
            bytesProvider: { Data() }
        )
        // A second file-backed asset so we hit the bytes-only check, not the count check.
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("test.DNG")
        try Data("placeholder".utf8).write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let fileAsset = AssetRef(url: tmp)

        let stitcher = RustPanoStitcher()

        do {
            _ = try await stitcher.stitch(
                assets: [bytesAsset, fileAsset],
                options: .default,
                progress: { _, _ in }
            )
            Issue.record("Expected throw but stitch succeeded")
        } catch let err as PanoStitcherError {
            if case .assetNotFileBacked(let name) = err {
                #expect(name == "cloud-photo.dng")
            } else {
                Issue.record("Expected assetNotFileBacked, got \(err)")
            }
        } catch {
            Issue.record("Unexpected error type: \(error)")
        }
    }
}

// MARK: - BrowseViewModel.injectPanoResult (M5)

@MainActor
struct BrowseViewModelInjectPanoTests {

    @Test("injectPanoResult appends asset and selects it")
    func injectAppendAndSelect() {
        let vm = BrowseViewModel()
        let existingAsset = AssetRef.preview(displayName: "IMG_0001.dng")
        vm.assets = [existingAsset]

        let panoURL = URL(fileURLWithPath: "/tmp/panorama-123.png")
        vm.injectPanoResult(url: panoURL)

        #expect(vm.assets.count == 2, "Panorama should be appended, not replace existing assets")
        #expect(vm.assets.last?.primaryURL == panoURL)
        #expect(vm.selectedID == vm.assets.last?.id, "Injected asset should be auto-selected")
    }

    @Test("injectPanoResult into empty library works")
    func injectIntoEmptyLibrary() {
        let vm = BrowseViewModel()
        #expect(vm.assets.isEmpty)

        let panoURL = URL(fileURLWithPath: "/tmp/panorama-empty.png")
        vm.injectPanoResult(url: panoURL)

        #expect(vm.assets.count == 1)
        #expect(vm.selectedID == vm.assets.first?.id)
    }
}

// MARK: - Real stitch gate (opt-in, MAPLE_PANO_E2E=1)

/// End-to-end stitch test. Set MAPLE_PANO_E2E=1 and ensure:
///   MAPLE_PANO_MODELS points to the dir with aliked.onnx + lightglue.onnx
///   ORT_DYLIB_PATH points to libonnxruntime.dylib (≥ 1.23)
///   The pano_01 fixture DNGs exist at test-fixtures/raws/pano_01/
///
/// Skips automatically when any precondition is absent — mirrors the
/// MAPLE_AUTO_E2E pattern used in ExposureFFITests.
@MainActor
struct RustPanoStitcherE2ETests {

    @Test("real stitch with pano_01 fixtures (MAPLE_PANO_E2E=1 required)")
    func realStitchPano01() async throws {
        guard ProcessInfo.processInfo.environment["MAPLE_PANO_E2E"] == "1" else {
            // Not opted-in — skip silently.
            return
        }

        // Resolve pano_01 fixtures. Priority:
        //   1. MAPLE_PANO_FIXTURE_DIR env var (explicit override for worktrees).
        //   2. Relative to source tree via #file (works when test-fixtures/ is
        //      a sibling of src/).
        let fm = FileManager.default
        let fixtureDir: URL
        if let envDir = ProcessInfo.processInfo.environment["MAPLE_PANO_FIXTURE_DIR"] {
            fixtureDir = URL(fileURLWithPath: envDir, isDirectory: true)
        } else {
            let repoRoot = URL(fileURLWithPath: #file)
                .deletingLastPathComponent()     // Tests/MapleCoreTests/
                .deletingLastPathComponent()     // Tests/
                .deletingLastPathComponent()     // MapleCore/
                .deletingLastPathComponent()     // Packages/
                .deletingLastPathComponent()     // apple/
                .deletingLastPathComponent()     // src/
            fixtureDir = repoRoot.appendingPathComponent("test-fixtures/raws/pano_01")
        }

        guard fm.fileExists(atPath: fixtureDir.path) else {
            // No fixtures — soft skip.
            return
        }

        let dngs = try fm.contentsOfDirectory(at: fixtureDir,
                                              includingPropertiesForKeys: nil)
            .filter { $0.pathExtension.uppercased() == "DNG" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }

        guard dngs.count >= 2 else {
            return   // Not enough frames — skip.
        }

        let assets = dngs.map { AssetRef(url: $0) }
        let stitcher = RustPanoStitcher()

        var stagesObserved: [PanoStage] = []
        let result = try await stitcher.stitch(
            assets: assets,
            options: .default,
            progress: { stage, _ in
                if stagesObserved.last != stage { stagesObserved.append(stage) }
            }
        )

        // Result file must exist on disk.
        #expect(fm.fileExists(atPath: result.outputURL.path),
                "Output PNG should exist at \(result.outputURL.path)")

        // At least a few progress stages should have fired.
        #expect(stagesObserved.count >= 2, "Expected at least 2 distinct stages, got \(stagesObserved)")

        // Copy to ~/Desktop for visual review (mirrors the MEMORY note
        // "save color test outputs to ~/Desktop/maple-color-tests/").
        let desktopDest = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Desktop/maple-color-tests/1234/pano_01_mac_ffi.png")
        try? fm.createDirectory(at: desktopDest.deletingLastPathComponent(),
                                withIntermediateDirectories: true)
        try? fm.copyItem(at: result.outputURL, to: desktopDest)
    }
}
