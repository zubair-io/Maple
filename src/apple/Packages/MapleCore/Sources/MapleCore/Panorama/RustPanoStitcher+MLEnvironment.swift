// RustPanoStitcher+MLEnvironment.swift — locate + validate the pano ML runtime.
//
// Split out of RustPanoStitcher.swift (file-budget). Resolves the models dir
// and ONNX Runtime dylib via PanoProvisioning (Settings → env → app-support),
// `setenv`s them for the Rust core, and re-verifies the auto-provisioned ORT
// dylib's pinned SHA-256 immediately before it is loaded.

import Foundation

extension RustPanoStitcher {
    /// Set `MAPLE_PANO_MODELS` and `ORT_DYLIB_PATH` in the process environment
    /// so the Rust `maple_pano` crate can locate the ONNX Runtime dylib and
    /// model files.
    ///
    /// Resolution order (via `PanoProvisioning`): Settings → env var →
    /// default app-support location. When a tier above the env var provides
    /// the path we `setenv` it; when the env var is already set we leave it.
    ///
    /// Throws `PanoStitcherError.modelsNotInstalled` if no tier yields a path
    /// that exists on disk, or if the auto-provisioned ORT dylib fails its
    /// load-time integrity check.
    func provisionMLEnvironment() throws {
        let fm = FileManager.default

        // ── Models directory ───────────────────────────────────────────────
        let modelsDir = provisioning.resolvedModelsDir()
        let settingsModels = UserDefaults.standard.string(forKey: PanoProvisioningDefaults.modelsDirKey)
        let hasSettingsModels = !(settingsModels?.isEmpty ?? true)
        let hasEnvModels = !(ProcessInfo.processInfo.environment["MAPLE_PANO_MODELS"]?.isEmpty ?? true)

        if hasSettingsModels || !hasEnvModels {
            guard let dir = modelsDir, fm.fileExists(atPath: dir.path) else {
                throw PanoStitcherError.modelsNotInstalled(
                    "Panorama models are not installed. Open Settings → Pano to download them, " +
                    "or set the Models Directory to a folder containing aliked.onnx + lightglue.onnx."
                )
            }
            setenv("MAPLE_PANO_MODELS", dir.path, 1)
        }

        // ── ORT dylib ──────────────────────────────────────────────────────
        let ortPath = provisioning.resolvedOrtDylibPath()
        let settingsOrt = UserDefaults.standard.string(forKey: PanoProvisioningDefaults.ortDylibPathKey)
        let hasSettingsOrt = !(settingsOrt?.isEmpty ?? true)
        let hasEnvOrt = !(ProcessInfo.processInfo.environment["ORT_DYLIB_PATH"]?.isEmpty ?? true)

        if hasSettingsOrt || !hasEnvOrt {
            guard let dylib = ortPath, fm.fileExists(atPath: dylib.path) else {
                throw PanoStitcherError.modelsNotInstalled(
                    "ONNX Runtime is not installed. Open Settings → Pano to download it, or set " +
                    "the ONNX Runtime Dylib Path to libonnxruntime.dylib (version ≥ 1.23)."
                )
            }
            // Load-time integrity for the AUTO-PROVISIONED dylib only (no
            // Settings/env override). The app runs with disable-library-validation
            // and the dylib lives in a user-writable location, so re-verify its
            // pinned SHA-256 immediately before dlopen and refuse a tampered file.
            // A user-specified override is the user's own dylib — not pin-checked.
            if !hasSettingsOrt && !hasEnvOrt {
                switch PanoProvisioner.verifyOrtDylibIntegrity(at: dylib) {
                case .ok, .notApplicable:
                    break
                case .mismatch:
                    throw PanoStitcherError.modelsNotInstalled(
                        "The installed ONNX Runtime failed its integrity check and won't be loaded " +
                        "(it may be corrupt or modified). Re-download it from Settings → Pano."
                    )
                case .unreadable:
                    throw PanoStitcherError.modelsNotInstalled(
                        "The installed ONNX Runtime couldn't be read for verification. " +
                        "Re-download it from Settings → Pano."
                    )
                }
            }
            setenv("ORT_DYLIB_PATH", dylib.path, 1)
        }
    }
}
