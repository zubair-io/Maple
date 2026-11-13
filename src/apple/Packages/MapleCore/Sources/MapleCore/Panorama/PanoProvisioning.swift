// PanoProvisioning.swift — Resolver for pano ML runtime paths (M6, #1241).
//
// Encapsulates the three-priority resolution order for the two required
// ML environment paths:
//
//   Priority 1 — UserDefaults (set via Settings → Pano):
//     maple.pano.settings.modelsDir.v1
//     maple.pano.settings.ortDylibPath.v1
//
//   Priority 2 — Process environment variables (dev / CI):
//     MAPLE_PANO_MODELS
//     ORT_DYLIB_PATH
//     Maple itself exports the resolved paths into these variables for the
//     core (PanoMLEnvironment); that export never reads back as this tier.
//
//   Priority 3 — Default app-support locations:
//     ~/Library/Application Support/app.justmaple.aperture/pano-models/
//     ~/Library/Application Support/app.justmaple.aperture/ort/libonnxruntime.dylib
//
// `RustPanoStitcher` uses this resolver instead of reading env directly so
// that in-app settings take precedence over shell env vars.
//
// `PanoProvisioningStatus` provides a lightweight "provisioned or not?"
// indicator for the settings UI — it checks whether both model files and
// the ORT dylib exist on disk (does NOT validate their contents).
//
// follow-up: #1234 M6 — auto-download / bundle ONNX models and
//   libonnxruntime.dylib so users don't need to configure paths manually.
//
// Ticket: #1241 / Part of #1234

import Foundation
import os

// MARK: - UserDefaults keys

/// Namespaced UserDefaults keys for Settings → Pano persistence.
/// Exposed so `PanoSettingsView` can read/write the same keys without
/// coupling to `PanoProvisioning` internals.
public enum PanoProvisioningDefaults {
    public static let modelsDirKey   = "maple.pano.settings.modelsDir.v1"
    public static let ortDylibPathKey = "maple.pano.settings.ortDylibPath.v1"
    public static let useMLMatcherKey = "maple.pano.settings.useMLMatcher.v1"
    static let modelsDirEnv = "MAPLE_PANO_MODELS"
    static let ortDylibPathEnv = "ORT_DYLIB_PATH"
}

// MARK: - PanoMLEnvironment

/// The core reads the ML paths only from the process environment, so the
/// resolved paths are exported there before each ML run. Each export
/// remembers the value it replaced, so while a variable still holds Maple's
/// own export the environment tier reads the value from before it: the
/// export never poses as a path the user set.
enum PanoMLEnvironment {
    private struct Export {
        let replaced: String?
        let value: String
    }

    private static let exports = OSAllocatedUnfairLock<[String: Export]>(initialState: [:])

    /// The variable as the user or the launching process set it.
    static func userValue(_ name: String) -> String? {
        exports.withLock { exports in
            let current = ProcessInfo.processInfo.environment[name]
            guard let export = exports[name], export.value == current else { return current }
            return export.replaced
        }
    }

    static func export(_ name: String, _ value: String) {
        exports.withLock { exports in
            let current = ProcessInfo.processInfo.environment[name]
            let replaced = exports[name].map { $0.value == current ? $0.replaced : current } ?? current
            exports[name] = Export(replaced: replaced, value: value)
            setenv(name, value, 1)
        }
    }
}

// MARK: - PanoProvisioningStatus

/// Lightweight status snapshot used by Settings → Pano to show the user
/// whether the current configuration resolves to usable paths on disk.
///
/// "Provisioned" means the resolved path exists on disk; it does NOT
/// validate that the files inside are the correct models or a compatible
/// ORT version — that validation happens at stitch time via the FFI.
public struct PanoProvisioningStatus: Sendable, Equatable {
    /// Where each resolved path came from.
    public enum Source: String, Sendable, Equatable {
        case settings       // UserDefaults (Settings → Pano)
        case environment    // env var (MAPLE_PANO_MODELS / ORT_DYLIB_PATH)
        case appSupport     // default app-support location
        case notSet         // nothing resolved (path is nil)
    }

    /// Resolved models directory URL (may not exist on disk).
    public let modelsDir: URL?
    /// Where `modelsDir` came from.
    public let modelsDirSource: Source
    /// Whether `modelsDir` holds every model file the core loads right now.
    public let modelsDirExists: Bool

    /// Resolved ORT dylib URL (may not exist on disk).
    public let ortDylibPath: URL?
    /// Where `ortDylibPath` came from.
    public let ortDylibSource: Source
    /// Whether `ortDylibPath` exists on disk right now and, when it is the
    /// auto-provisioned one, still matches its pinned digest.
    public let ortDylibExists: Bool

    /// `true` when both paths resolve to something that exists on disk.
    public var isProvisioned: Bool { modelsDirExists && ortDylibExists }
}

// MARK: - PanoProvisioning

/// Resolves the two ML-runtime paths needed by `RustPanoStitcher`.
///
/// Call `resolve()` at stitch-start to get both paths; call `status()`
/// from the Settings → Pano view to drive the status indicator.
///
/// Thread safety: all methods are synchronous and read-only (they read
/// UserDefaults + env + FileManager); safe to call from any thread.
///
/// `@unchecked Sendable`: the only stored property is a `UserDefaults`,
/// which is documented thread-safe but not marked `Sendable` by the SDK.
/// `RustPanoStitcher` captures a `PanoProvisioning` into a detached stitch
/// task, so the conformance is required; plain `Sendable` would be a
/// concurrency error under the Swift 6 language mode (the stored
/// `UserDefaults` is non-Sendable).
public struct PanoProvisioning: @unchecked Sendable {

    // MARK: - Defaults instance

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    // MARK: - Resolved paths (for stitch-time use)

    /// Resolved models directory. Priority: settings → env → app-support.
    /// Returns `nil` only when all three tiers yield nothing (never in
    /// practice — the app-support tier always constructs a URL even if the
    /// directory doesn't exist yet).
    public func resolvedModelsDir() -> URL? {
        resolvedModels().url
    }

    /// Resolved ORT dylib path. Priority: settings → env → app-support.
    public func resolvedOrtDylibPath() -> URL? {
        resolvedOrtDylib().url
    }

    private func resolvedModels() -> (url: URL?, source: PanoProvisioningStatus.Source) {
        resolveWithSource(
            settingsKey: PanoProvisioningDefaults.modelsDirKey,
            envKey: PanoProvisioningDefaults.modelsDirEnv,
            isDirectory: true,
            defaultURL: Self.defaultModelsDir()
        )
    }

    private func resolvedOrtDylib() -> (url: URL?, source: PanoProvisioningStatus.Source) {
        resolveWithSource(
            settingsKey: PanoProvisioningDefaults.ortDylibPathKey,
            envKey: PanoProvisioningDefaults.ortDylibPathEnv,
            isDirectory: false,
            defaultURL: Self.defaultOrtDylibPath()
        )
    }

    // MARK: - Engine selection

    /// The engine the next stitch uses: ML only when the user turned it on
    /// in Settings → Pano AND its models/runtime are on disk; classical
    /// otherwise, so a merge never waits on (or fails for) a download.
    public func featureEngine() -> PanoFeatureEngine {
        mlOptedIn && PanoProvisioner.isReady(status()) ? .ml : .classical
    }

    /// The resolved ML paths with their modification dates; changes when the
    /// user points Settings → Pano elsewhere or re-downloads the files.
    public func mlEnvironmentFingerprint() -> String {
        [resolvedModelsDir(), resolvedOrtDylibPath()]
            .map { url -> String in
                guard let url else { return "-" }
                let modified = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
                return "\(url.path)@\(modified?.timeIntervalSince1970 ?? 0)"
            }
            .joined(separator: "|")
    }

    /// Whether Settings → Pano turned the ML matcher on, installed or not.
    public var mlOptedIn: Bool {
        defaults.bool(forKey: PanoProvisioningDefaults.useMLMatcherKey)
    }

    // MARK: - Status snapshot (for Settings → Pano UI)

    /// Snapshot of the current resolution state — which paths resolved and
    /// whether they exist on disk. On macOS an auto-provisioned ORT dylib is
    /// also checked against its pinned digest, hashed once per file version.
    public func status() -> PanoProvisioningStatus {
        let (modelsDir, modelsSource) = resolvedModels()
        let modelsDirExists = modelsDir.map(Self.holdsEveryModel) ?? false
        let (ortPath, ortSource) = resolvedOrtDylib()
        let ortExists = ortPath.map { Self.isUsableOrtDylib($0, source: ortSource) } ?? false

        return PanoProvisioningStatus(
            modelsDir:       modelsDir,
            modelsDirSource: modelsSource,
            modelsDirExists: modelsDirExists,
            ortDylibPath:    ortPath,
            ortDylibSource:  ortSource,
            ortDylibExists:  ortExists
        )
    }

    // MARK: - Private helpers

    /// Resolve a path and indicate which tier it came from.
    private func resolveWithSource(
        settingsKey: String,
        envKey: String,
        isDirectory: Bool,
        defaultURL: URL?
    ) -> (URL?, PanoProvisioningStatus.Source) {
        // 1. Settings
        if let saved = defaults.string(forKey: settingsKey), !saved.isEmpty {
            return (URL(fileURLWithPath: saved, isDirectory: isDirectory), .settings)
        }
        // 2. Env
        if let envVal = PanoMLEnvironment.userValue(envKey), !envVal.isEmpty {
            return (URL(fileURLWithPath: envVal, isDirectory: isDirectory), .environment)
        }
        // 3. Default
        if let def = defaultURL {
            return (def, .appSupport)
        }
        return (nil, .notSet)
    }

    /// A directory that exists but lacks a model (an interrupted download)
    /// is not installed: the core would refuse it at merge time.
    private static func holdsEveryModel(_ dir: URL) -> Bool {
        PanoProvisionManifest.modelFilenames.allSatisfy { filename in
            var isDirectory: ObjCBool = false
            let exists = FileManager.default.fileExists(
                atPath: dir.appendingPathComponent(filename).path, isDirectory: &isDirectory)
            return exists && !isDirectory.boolValue
        }
    }

    /// The auto-provisioned dylib must also match its pinned digest: a
    /// corrupt one then reads as not installed, so Settings offers the
    /// download that replaces it. A user's own dylib only has to exist.
    private static func isUsableOrtDylib(_ url: URL, source: PanoProvisioningStatus.Source) -> Bool {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path) else { return false }
        guard source == .appSupport else { return true }
        let identity = OrtDylibIdentity(
            path: url.path,
            modified: attributes[.modificationDate] as? Date,
            size: attributes[.size] as? Int)
        if let known = verifiedOrtDylibs.withLock({ $0[identity] }) { return known }
        let usable = switch PanoProvisioner.verifyOrtDylibIntegrity(at: url) {
        case .ok, .notApplicable: true
        case .mismatch, .unreadable: false
        }
        verifiedOrtDylibs.withLock { $0[identity] = usable }
        return usable
    }

    /// Hashing the dylib takes tens of milliseconds and Settings asks on
    /// every view update, so a verdict holds until the file changes.
    private struct OrtDylibIdentity: Hashable {
        let path: String
        let modified: Date?
        let size: Int?
    }

    private static let verifiedOrtDylibs = OSAllocatedUnfairLock<[OrtDylibIdentity: Bool]>(initialState: [:])

    /// The model file names as the user reads them in Settings and errors.
    public static var modelFilenameList: String {
        PanoProvisionManifest.modelFilenames.joined(separator: " and ")
    }

    // MARK: - Default app-support locations

    static func defaultModelsDir() -> URL? {
        FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("app.justmaple.aperture/pano-models", isDirectory: true)
    }

    static func defaultOrtDylibPath() -> URL? {
        FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("app.justmaple.aperture/ort/libonnxruntime.dylib")
    }
}
