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

/// An empty UserDefaults suite: no path overrides, ML matcher toggle unset.
private func freshDefaults() -> UserDefaults {
    let name = "rust-pano-stitcher-\(UUID().uuidString)"
    let suite = UserDefaults(suiteName: name)!
    suite.removePersistentDomain(forName: name)
    return suite
}

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

    @Test("assetNotFileBacked embeds the asset name")
    func assetNotFileBackedEmbedsName() {
        let err = PanoStitcherError.assetNotFileBacked("IMG_0042.dng")
        #expect(err.errorDescription?.contains("IMG_0042.dng") == true)
    }

    @Test("user-facing pano errors carry no ticket or milestone references (#5487)")
    func userFacingErrorsHaveNoDeveloperText() {
        let errors: [PanoStitcherError] = [
            .unsupportedPlatform,
            .assetNotFileBacked("IMG_0042.dng"),
            .pathEncodingError(URL(fileURLWithPath: "/tmp/x.dng")),
            .stitchFailed(code: -2, message: "the frames do not overlap"),
            .previewUndecodable,
        ]
        for err in errors {
            let text = err.errorDescription ?? ""
            #expect(!text.isEmpty)
            #expect(text.range(of: #"#\d|M\d|FFI|code -?\d"#, options: .regularExpression) == nil,
                    "Developer text in: \(text)")
        }
    }

    @Test("stitchFailed shows the message without the return code")
    func stitchFailedShowsMessageWithoutCode() {
        let err = PanoStitcherError.stitchFailed(code: -7, message: "pipeline error")
        let desc = err.errorDescription ?? ""
        #expect(desc.contains("pipeline error"))
        #expect(!desc.contains("-7"))
    }

    @Test("the core's entry-point prefix is stripped from user-facing messages")
    func coreEntryPointPrefixIsStripped() {
        let raw = "maple_pano_stitch: fewer than 2 frames overlap — check the selection"
        let message = PanoFFICall.userMessage(fromCoreError: raw)
        #expect(message == "fewer than 2 frames overlap — check the selection")
        let shown = PanoStitcherError.stitchFailed(code: -2, message: message).errorDescription ?? ""
        #expect(!shown.contains("maple_"))
        #expect(PanoFFICall.userMessage(fromCoreError: "no prefix here") == "no prefix here")
    }
}

// MARK: - RustPanoStitcher: missing models error path

@MainActor
struct RustPanoStitcherErrorPathTests {

    /// A fresh install has no ML runtime and the ML toggle is off: the stitch
    /// must go straight to the classical matcher (#4554), so placeholder
    /// frames reach the FFI and fail in decode, never in the models check.
    @Test("fresh install stitches with the classical matcher, not a models check")
    func freshInstallUsesClassical() async throws {
        let savedModels = ProcessInfo.processInfo.environment["MAPLE_PANO_MODELS"]
        let savedOrt = ProcessInfo.processInfo.environment["ORT_DYLIB_PATH"]
        defer {
            if let v = savedModels { setenv("MAPLE_PANO_MODELS", v, 1) } else { unsetenv("MAPLE_PANO_MODELS") }
            if let v = savedOrt   { setenv("ORT_DYLIB_PATH", v, 1)    } else { unsetenv("ORT_DYLIB_PATH")    }
        }
        unsetenv("MAPLE_PANO_MODELS")
        unsetenv("ORT_DYLIB_PATH")

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("rust-pano-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let a = tmp.appendingPathComponent("A.DNG")
        let b = tmp.appendingPathComponent("B.DNG")
        try Data("placeholder".utf8).write(to: a)
        try Data("placeholder".utf8).write(to: b)

        let provisioning = PanoProvisioning(defaults: freshDefaults())
        #expect(provisioning.featureEngine() == .classical)

        do {
            _ = try await RustPanoStitcher(provisioning: provisioning).stitch(
                assets: [AssetRef(url: a), AssetRef(url: b)],
                options: .default,
                alignment: nil,
                maxCanvasPixels: nil,
                progress: { _, _ in }
            )
            Issue.record("Placeholder frames cannot stitch")
        } catch PanoStitcherError.stitchFailed {
        } catch {
            Issue.record("Expected a classical-path decode failure, got \(error)")
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
                alignment: nil,
                maxCanvasPixels: nil,
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

/// End-to-end stitches of the pano_01 fixture. Set MAPLE_PANO_E2E=1; the
/// DNGs come from MAPLE_PANO_FIXTURE_DIR or test-fixtures/raws/pano_01/.
/// The ML test additionally needs MAPLE_PANO_MODELS + ORT_DYLIB_PATH; the
/// classical test clears both to prove a fresh install merges (#4554).
/// Each skips silently when a precondition is absent — mirrors the
/// MAPLE_AUTO_E2E pattern used in ExposureFFITests.
@MainActor
@Suite(.serialized)
struct RustPanoStitcherE2ETests {

    private func pano01Assets() throws -> [AssetRef]? {
        guard ProcessInfo.processInfo.environment["MAPLE_PANO_E2E"] == "1" else { return nil }
        let fm = FileManager.default
        let fixtureDir = ProcessInfo.processInfo.environment["MAPLE_PANO_FIXTURE_DIR"]
            .map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()     // …/Tests/MapleCoreTests
                .deletingLastPathComponent()     // …/MapleCore/Tests
                .deletingLastPathComponent()     // …/Packages/MapleCore
                .deletingLastPathComponent()     // …/apple/Packages
                .deletingLastPathComponent()     // …/src/apple
                .deletingLastPathComponent()     // …/src
                .deletingLastPathComponent()     // repo root
                .appendingPathComponent("test-fixtures/raws/pano_01")
        guard fm.fileExists(atPath: fixtureDir.path) else { return nil }
        let dngs = try fm.contentsOfDirectory(at: fixtureDir, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension.uppercased() == "DNG" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        return dngs.count >= 2 ? dngs.map { AssetRef(url: $0) } : nil
    }

    /// Preview, then the full stitch from the preview's alignment (#4579),
    /// with one stitcher so both resolve the same engine.
    private func stitchAndCheck(
        _ assets: [AssetRef],
        provisioning: PanoProvisioning,
        desktopName: String
    ) async throws -> PanoResult {
        let stitcher = RustPanoStitcher(provisioning: provisioning)
        let clock = ContinuousClock()
        let previewStart = clock.now
        let preview = try await stitcher.preview(
            assets: assets,
            options: .default,
            alignment: nil,
            progress: { _, _ in }
        )
        #expect(max(preview.image.width, preview.image.height) > 1024,
                "Preview long edge should be ~2048 px, got \(preview.image.width)×\(preview.image.height)")
        #expect(preview.alignmentOutcome == .solved)
        print("pano E2E: preview \(clock.now - previewStart), \(preview.image.width)×\(preview.image.height). \(preview.alignmentOutcome.summary)")

        var stagesObserved: [PanoStage] = []
        var solvingReachedAfter: Duration?
        let stitchStart = clock.now
        let result = try await stitcher.stitch(
            assets: assets,
            options: .default,
            alignment: preview.alignment,
            maxCanvasPixels: nil,
            progress: { stage, _ in
                if stagesObserved.last != stage { stagesObserved.append(stage) }
                if stage == .solving, solvingReachedAfter == nil { solvingReachedAfter = clock.now - stitchStart }
            }
        )
        print("pano E2E: stitch \(clock.now - stitchStart), refinement reached after \(solvingReachedAfter.map { "\($0)" } ?? "never"). \(result.alignmentOutcome.summary)")
        #expect(result.alignmentOutcome == .reused,
                "The full stitch must start from the preview's alignment, got \(result.alignmentOutcome)")
        #expect(result.reportSummary.contains("matching skipped"))

        let fm = FileManager.default
        #expect(fm.fileExists(atPath: result.outputURL.path),
                "Output PNG should exist at \(result.outputURL.path)")
        #expect(stagesObserved.count >= 2, "Expected at least 2 distinct stages, got \(stagesObserved)")

        let desktopDest = fm.homeDirectoryForCurrentUser
            .appendingPathComponent("Desktop/maple-color-tests/1234/\(desktopName)")
        try? fm.createDirectory(at: desktopDest.deletingLastPathComponent(),
                                withIntermediateDirectories: true)
        try? fm.removeItem(at: desktopDest)
        try? fm.copyItem(at: result.outputURL, to: desktopDest)
        return result
    }

    @Test("ML stitch of pano_01 reports the ML matcher (MAPLE_PANO_E2E=1)")
    func realStitchPano01() async throws {
        guard let assets = try pano01Assets(),
              ProcessInfo.processInfo.environment["MAPLE_PANO_MODELS"] != nil,
              ProcessInfo.processInfo.environment["ORT_DYLIB_PATH"] != nil else { return }
        let defaults = freshDefaults()
        defaults.set(true, forKey: PanoProvisioningDefaults.useMLMatcherKey)
        let provisioning = PanoProvisioning(defaults: defaults)
        #expect(provisioning.featureEngine() == .ml)

        let result = try await stitchAndCheck(
            assets, provisioning: provisioning, desktopName: "pano_01_mac_ffi.png")
        #expect(result.reportSummary.contains(PanoFeatureEngine.ml.displayName))
    }

    @Test("fresh install stitches pano_01 with the classical matcher (MAPLE_PANO_E2E=1)")
    func classicalStitchPano01WithoutModels() async throws {
        guard let assets = try pano01Assets() else { return }
        let savedModels = ProcessInfo.processInfo.environment["MAPLE_PANO_MODELS"]
        let savedOrt = ProcessInfo.processInfo.environment["ORT_DYLIB_PATH"]
        defer {
            if let v = savedModels { setenv("MAPLE_PANO_MODELS", v, 1) } else { unsetenv("MAPLE_PANO_MODELS") }
            if let v = savedOrt   { setenv("ORT_DYLIB_PATH", v, 1)    } else { unsetenv("ORT_DYLIB_PATH")    }
        }
        let missing = FileManager.default.temporaryDirectory
            .appendingPathComponent("no-pano-ml-\(UUID().uuidString)")
        setenv("MAPLE_PANO_MODELS", missing.path, 1)
        setenv("ORT_DYLIB_PATH", missing.appendingPathComponent("libonnxruntime.dylib").path, 1)
        let provisioning = PanoProvisioning(defaults: freshDefaults())
        #expect(!PanoProvisioner.isReady(provisioning.status()))

        let result = try await stitchAndCheck(
            assets, provisioning: provisioning, desktopName: "pano_01_mac_ffi_classical.png")
        #expect(result.reportSummary.contains(PanoFeatureEngine.classical.displayName))
        print("RustPanoStitcherE2ETests classical: \(result.reportSummary)")
    }
}
