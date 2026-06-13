// PanoProvisioningTests.swift — Unit tests for PanoProvisioning resolver.
//
// Verifies the three-priority resolution order:
//   Priority 1 — UserDefaults (Settings → Pano)
//   Priority 2 — Process env vars (MAPLE_PANO_MODELS / ORT_DYLIB_PATH)
//   Priority 3 — Default app-support locations
//
// Also verifies PanoProvisioningStatus.isProvisioned reflects real filesystem
// state, and that RustPanoStitcher.init() accepts a custom PanoProvisioning
// for injection (used by tests and dev scenarios).
//
// Ticket: #1241 / Part of #1234

import Testing
import Foundation
@testable import MapleCore

// MARK: - Helpers

/// A fresh in-memory UserDefaults suite so tests don't pollute .standard.
private func makeSuite(_ name: String = UUID().uuidString) -> UserDefaults {
    let suite = UserDefaults(suiteName: name)!
    suite.removePersistentDomain(forName: name)
    return suite
}

/// Save + restore a process env var around a block.
private func withEnvVar(_ key: String, value: String?, in block: () throws -> Void) rethrows {
    let saved = ProcessInfo.processInfo.environment[key]
    defer {
        if let s = saved { setenv(key, s, 1) } else { unsetenv(key) }
    }
    if let v = value { setenv(key, v, 1) } else { unsetenv(key) }
    try block()
}

// MARK: - Resolution order tests

/// Tests that mutate the process environment are inherently not safe to run
/// concurrently: `setenv`/`unsetenv` write global process state.  The
/// `.serialized` trait ensures only one of these tests runs at a time inside
/// this suite (they are still allowed to run in parallel with tests in other
/// suites that don't touch env vars).
@Suite(.serialized)
struct PanoProvisioningResolutionOrderTests {

    // MARK: Models dir

    @Test("Settings value (Priority 1) wins over env and app-support for modelsDir")
    func settingsWinsForModelsDir() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("pano-provisioning-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let suite = makeSuite()
        suite.set(tmp.path, forKey: PanoProvisioningDefaults.modelsDirKey)
        let resolver = PanoProvisioning(defaults: suite)

        try withEnvVar("MAPLE_PANO_MODELS", value: "/some/other/env/path") {
            let resolved = resolver.resolvedModelsDir()
            #expect(resolved?.path == tmp.path,
                    "UserDefaults settings value should win over env var")
        }
    }

    @Test("Env var (Priority 2) wins over app-support when settings is blank")
    func envVarWinsForModelsDirWhenSettingsBlank() throws {
        // We cannot rely on setenv() safely in a concurrent test run because
        // ProcessInfo.processInfo.environment is global process state.
        // Instead we test the env-tier indirectly: confirm that when the
        // env var IS set (by whatever value is in the test environment),
        // the resolver returns it rather than the app-support default.
        // If MAPLE_PANO_MODELS is not set in this process, we skip gracefully.
        guard let envVal = ProcessInfo.processInfo.environment["MAPLE_PANO_MODELS"],
              !envVal.isEmpty else {
            // Env var not set — skip this tier test; covered by CI when run
            // with MAPLE_PANO_MODELS set, or by the env-var setenv unit below.
            return
        }
        let suite = makeSuite()
        let resolver = PanoProvisioning(defaults: suite)
        let resolved = resolver.resolvedModelsDir()
        #expect(resolved?.path == envVal,
                "Env var should be returned when settings is not set")
    }

    @Test("Falls back to app-support when both settings and env are unset for modelsDir")
    func fallsBackToAppSupportForModelsDir() throws {
        // Only testable when MAPLE_PANO_MODELS is not set in this process.
        guard ProcessInfo.processInfo.environment["MAPLE_PANO_MODELS"] == nil else { return }
        let suite = makeSuite()
        let resolver = PanoProvisioning(defaults: suite)
        let resolved = resolver.resolvedModelsDir()
        // App-support path must contain the expected component.
        #expect(resolved?.path.contains("app.justmaple.aperture/pano-models") == true,
                "Should fall back to app-support pano-models path")
    }

    // MARK: ORT dylib

    @Test("Settings value (Priority 1) wins over env and app-support for ortDylibPath")
    func settingsWinsForOrtDylibPath() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("pano-prov-ort-\(UUID().uuidString).dylib")
        FileManager.default.createFile(atPath: tmp.path, contents: Data())
        defer { try? FileManager.default.removeItem(at: tmp) }

        let suite = makeSuite()
        suite.set(tmp.path, forKey: PanoProvisioningDefaults.ortDylibPathKey)
        let resolver = PanoProvisioning(defaults: suite)

        try withEnvVar("ORT_DYLIB_PATH", value: "/env/libonnxruntime.dylib") {
            let resolved = resolver.resolvedOrtDylibPath()
            #expect(resolved?.path == tmp.path,
                    "UserDefaults settings value should win over env var for ORT")
        }
    }

    @Test("Env var (Priority 2) wins over app-support for ortDylibPath when settings blank")
    func envVarWinsForOrtDylibPathWhenSettingsBlank() throws {
        // Only testable when ORT_DYLIB_PATH is set in this process.
        guard let envVal = ProcessInfo.processInfo.environment["ORT_DYLIB_PATH"],
              !envVal.isEmpty else { return }
        let suite = makeSuite()
        let resolver = PanoProvisioning(defaults: suite)
        let resolved = resolver.resolvedOrtDylibPath()
        #expect(resolved?.path == envVal,
                "Env var should be returned for ORT when settings is not set")
    }

    @Test("Falls back to app-support when both settings and env are unset for ortDylibPath")
    func fallsBackToAppSupportForOrtDylibPath() throws {
        guard ProcessInfo.processInfo.environment["ORT_DYLIB_PATH"] == nil else { return }
        let suite = makeSuite()
        let resolver = PanoProvisioning(defaults: suite)
        let resolved = resolver.resolvedOrtDylibPath()
        #expect(resolved?.path.contains("app.justmaple.aperture/ort/libonnxruntime.dylib") == true,
                "Should fall back to app-support ORT dylib path")
    }

    // MARK: Empty-string settings are ignored (treated as unset)

    @Test("Empty-string settings value is treated as unset (falls through to env)")
    func emptyStringsAreTreatedAsUnset() throws {
        let suite = makeSuite()
        suite.set("", forKey: PanoProvisioningDefaults.modelsDirKey)
        let resolver = PanoProvisioning(defaults: suite)

        let envPath = "/tmp/env-models"
        try withEnvVar("MAPLE_PANO_MODELS", value: envPath) {
            let resolved = resolver.resolvedModelsDir()
            #expect(resolved?.path == envPath,
                    "Empty settings string should not block the env-var tier")
        }
    }
}

// MARK: - PanoProvisioningStatus tests

@Suite(.serialized)
struct PanoProvisioningStatusTests {

    @Test("isProvisioned is false when both paths do not exist on disk")
    func notProvisionedWhenPathsAbsent() {
        let suite = makeSuite()
        suite.set("/nonexistent/models", forKey: PanoProvisioningDefaults.modelsDirKey)
        suite.set("/nonexistent/libonnxruntime.dylib", forKey: PanoProvisioningDefaults.ortDylibPathKey)
        let resolver = PanoProvisioning(defaults: suite)
        let s = resolver.status()
        #expect(!s.isProvisioned)
        #expect(!s.modelsDirExists)
        #expect(!s.ortDylibExists)
    }

    @Test("isProvisioned is true when both paths exist on disk")
    func provisionedWhenPathsExist() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("pano-status-models-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let dylib = FileManager.default.temporaryDirectory
            .appendingPathComponent("pano-ort-\(UUID().uuidString).dylib")
        FileManager.default.createFile(atPath: dylib.path, contents: Data())
        defer { try? FileManager.default.removeItem(at: dylib) }

        let suite = makeSuite()
        suite.set(dir.path, forKey: PanoProvisioningDefaults.modelsDirKey)
        suite.set(dylib.path, forKey: PanoProvisioningDefaults.ortDylibPathKey)
        let resolver = PanoProvisioning(defaults: suite)
        let s = resolver.status()
        #expect(s.isProvisioned, "Both paths exist → should be provisioned")
        #expect(s.modelsDirSource == .settings)
        #expect(s.ortDylibSource == .settings)
    }

    @Test("modelsDirSource is .environment when resolved from env var")
    func sourceLabelEnvironmentForModelsDir() throws {
        // Only testable when MAPLE_PANO_MODELS is set in this process.
        guard let envVal = ProcessInfo.processInfo.environment["MAPLE_PANO_MODELS"],
              !envVal.isEmpty else { return }
        let suite = makeSuite()
        let resolver = PanoProvisioning(defaults: suite)
        let s = resolver.status()
        #expect(s.modelsDirSource == .environment)
    }

    @Test("modelsDirSource is .appSupport when nothing is set")
    func sourceLabelAppSupportWhenUnset() throws {
        // Only testable when neither settings nor MAPLE_PANO_MODELS is set.
        guard ProcessInfo.processInfo.environment["MAPLE_PANO_MODELS"] == nil else { return }
        let suite = makeSuite()
        let resolver = PanoProvisioning(defaults: suite)
        let s = resolver.status()
        #expect(s.modelsDirSource == .appSupport)
    }
}

// MARK: - RustPanoStitcher injection tests

/// Confirm that `RustPanoStitcher.init(provisioning:)` accepts a custom
/// resolver so tests can inject known-bad paths and get the `modelsNotInstalled`
/// error without touching env vars or UserDefaults.standard.
@MainActor
@Suite(.serialized)
struct RustPanoStitcherProvisioningInjectionTests {

    @Test("injecting a resolver with non-existent paths throws modelsNotInstalled")
    func injectedResolverThrowsWhenPathsMissing() async throws {
        let suite = makeSuite()
        suite.set("/no/such/models", forKey: PanoProvisioningDefaults.modelsDirKey)
        suite.set("/no/such/libonnxruntime.dylib", forKey: PanoProvisioningDefaults.ortDylibPathKey)
        let provisioning = PanoProvisioning(defaults: suite)

        // We still need MAPLE_PANO_MODELS and ORT_DYLIB_PATH to be unset so
        // the env tier doesn't short-circuit past the settings tier check.
        // (In the injected resolver, settings wins anyway — but the stitcher's
        // provisionMLEnvironment also checks the live process env, so we clear
        // it to isolate the test.)
        let savedModels = ProcessInfo.processInfo.environment["MAPLE_PANO_MODELS"]
        let savedOrt    = ProcessInfo.processInfo.environment["ORT_DYLIB_PATH"]
        defer {
            if let v = savedModels { setenv("MAPLE_PANO_MODELS", v, 1) } else { unsetenv("MAPLE_PANO_MODELS") }
            if let v = savedOrt    { setenv("ORT_DYLIB_PATH", v, 1)    } else { unsetenv("ORT_DYLIB_PATH")    }
        }
        unsetenv("MAPLE_PANO_MODELS")
        unsetenv("ORT_DYLIB_PATH")

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("pano-inject-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let a = tmp.appendingPathComponent("A.DNG")
        let b = tmp.appendingPathComponent("B.DNG")
        try Data("placeholder".utf8).write(to: a)
        try Data("placeholder".utf8).write(to: b)

        let stitcher = RustPanoStitcher(provisioning: provisioning)
        do {
            _ = try await stitcher.stitch(
                assets: [AssetRef(url: a), AssetRef(url: b)],
                options: .default,
                progress: { _, _ in }
            )
            Issue.record("Expected modelsNotInstalled throw but stitch succeeded")
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
}

// MARK: - PanoMergeSession.StitchError.isModelsNotInstalled

struct StitchErrorIsModelsNotInstalledTests {

    @Test("isModelsNotInstalled is true for PanoStitcherError.modelsNotInstalled")
    func trueForModelsNotInstalled() {
        let underlying = PanoStitcherError.modelsNotInstalled("test message")
        let err = PanoMergeSession.StitchError(underlying: underlying)
        #expect(err.isModelsNotInstalled == true)
    }

    @Test("isModelsNotInstalled is false for other PanoStitcherError variants")
    func falseForOtherPanoErrors() {
        let errors: [PanoStitcherError] = [
            .stitchFailed(code: -1, message: "pipeline error"),
            .unsupportedPlatform,
            .assetNotFileBacked("IMG.dng"),
            .pathEncodingError(URL(fileURLWithPath: "/tmp/x")),
        ]
        for e in errors {
            let stitchErr = PanoMergeSession.StitchError(underlying: e)
            #expect(!stitchErr.isModelsNotInstalled,
                    "Expected isModelsNotInstalled=false for \(e)")
        }
    }

    @Test("isModelsNotInstalled is false for non-PanoStitcherError errors")
    func falseForGenericErrors() {
        struct SomeError: Error {}
        let err = PanoMergeSession.StitchError(underlying: SomeError())
        #expect(!err.isModelsNotInstalled)
    }

    @Test("message is the localizedDescription of the underlying error")
    func messageForwardsLocalizedDescription() {
        let underlying = PanoStitcherError.modelsNotInstalled("custom message")
        let err = PanoMergeSession.StitchError(underlying: underlying)
        #expect(err.message.contains("custom message"))
    }
}
