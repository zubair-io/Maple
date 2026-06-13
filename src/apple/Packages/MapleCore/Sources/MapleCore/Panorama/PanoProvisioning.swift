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
//
//   Priority 3 — Default app-support locations:
//     ~/Library/Application Support/app.justmaple.aperture/pano-models/
//     ~/Library/Application Support/app.justmaple.aperture/ort/libonnxruntime.dylib
//
// `RustPanoStitcher` uses this resolver instead of reading env directly so
// that in-app settings take precedence over shell env vars.
//
// `PanoProvisioningStatus` provides a lightweight "provisioned or not?"
// indicator for the settings UI — it checks whether the resolved paths
// exist on disk (does NOT validate model file contents).
//
// follow-up: #1234 M6 — auto-download / bundle ONNX models and
//   libonnxruntime.dylib so users don't need to configure paths manually.
//
// Ticket: #1241 / Part of #1234

import Foundation

// MARK: - UserDefaults keys

/// Namespaced UserDefaults keys for Settings → Pano persistence.
/// Exposed so `PanoSettingsView` can read/write the same keys without
/// coupling to `PanoProvisioning` internals.
public enum PanoProvisioningDefaults {
    public static let modelsDirKey   = "maple.pano.settings.modelsDir.v1"
    public static let ortDylibPathKey = "maple.pano.settings.ortDylibPath.v1"
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
    /// Whether `modelsDir` actually exists on disk right now.
    public let modelsDirExists: Bool

    /// Resolved ORT dylib URL (may not exist on disk).
    public let ortDylibPath: URL?
    /// Where `ortDylibPath` came from.
    public let ortDylibSource: Source
    /// Whether `ortDylibPath` actually exists on disk right now.
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
public struct PanoProvisioning: Sendable {

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
        // 1. Settings
        if let saved = defaults.string(forKey: PanoProvisioningDefaults.modelsDirKey),
           !saved.isEmpty {
            return URL(fileURLWithPath: saved, isDirectory: true)
        }
        // 2. Environment
        if let envVal = ProcessInfo.processInfo.environment["MAPLE_PANO_MODELS"],
           !envVal.isEmpty {
            return URL(fileURLWithPath: envVal, isDirectory: true)
        }
        // 3. Default app-support
        return Self.defaultModelsDir()
    }

    /// Resolved ORT dylib path. Priority: settings → env → app-support.
    public func resolvedOrtDylibPath() -> URL? {
        // 1. Settings
        if let saved = defaults.string(forKey: PanoProvisioningDefaults.ortDylibPathKey),
           !saved.isEmpty {
            return URL(fileURLWithPath: saved)
        }
        // 2. Environment
        if let envVal = ProcessInfo.processInfo.environment["ORT_DYLIB_PATH"],
           !envVal.isEmpty {
            return URL(fileURLWithPath: envVal)
        }
        // 3. Default app-support
        return Self.defaultOrtDylibPath()
    }

    // MARK: - Status snapshot (for Settings → Pano UI)

    /// Snapshot of the current resolution state — which paths resolved and
    /// whether they exist on disk.  Cheap to call from a SwiftUI `.task`.
    public func status() -> PanoProvisioningStatus {
        let fm = FileManager.default

        let (modelsDir, modelsSource) = resolveWithSource(
            settingsKey: PanoProvisioningDefaults.modelsDirKey,
            envKey: "MAPLE_PANO_MODELS",
            isDirectory: true,
            defaultURL: Self.defaultModelsDir()
        )
        let modelsDirExists: Bool
        if let dir = modelsDir {
            var isDirFlag: ObjCBool = false
            let exists = fm.fileExists(atPath: dir.path, isDirectory: &isDirFlag)
            modelsDirExists = exists && isDirFlag.boolValue
        } else {
            modelsDirExists = false
        }

        let (ortPath, ortSource) = resolveWithSource(
            settingsKey: PanoProvisioningDefaults.ortDylibPathKey,
            envKey: "ORT_DYLIB_PATH",
            isDirectory: false,
            defaultURL: Self.defaultOrtDylibPath()
        )
        let ortExists = ortPath.map { fm.fileExists(atPath: $0.path) } ?? false

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
        if let envVal = ProcessInfo.processInfo.environment[envKey], !envVal.isEmpty {
            return (URL(fileURLWithPath: envVal, isDirectory: isDirectory), .environment)
        }
        // 3. Default
        if let def = defaultURL {
            return (def, .appSupport)
        }
        return (nil, .notSet)
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
