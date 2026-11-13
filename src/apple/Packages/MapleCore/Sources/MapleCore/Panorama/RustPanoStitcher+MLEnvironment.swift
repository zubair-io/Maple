// RustPanoStitcher+MLEnvironment.swift — locate + validate the pano ML runtime.
//
// Split out of RustPanoStitcher.swift (file-budget). Resolves the models dir
// and ONNX Runtime dylib via PanoProvisioning (Settings → env → app-support),
// exports them for the Rust core (PanoMLEnvironment), and re-verifies the
// auto-provisioned ORT dylib's pinned SHA-256 immediately before it is loaded.

import Foundation

extension RustPanoStitcher {
    /// Export `MAPLE_PANO_MODELS` and `ORT_DYLIB_PATH` for the Rust core,
    /// which reads the ML paths only from the process environment.
    ///
    /// Every run resolves afresh (Settings → launch environment → default
    /// app-support location) and exports the result, so a path cleared in
    /// Settings falls back to the next tier instead of the last export.
    ///
    /// Throws `PanoStitcherError.modelsNotInstalled` if the resolved models
    /// directory lacks a model or the ORT dylib is missing, or if the
    /// auto-provisioned ORT dylib fails its load-time integrity check.
    func provisionMLEnvironment() throws {
        let status = provisioning.status()
        guard let modelsDir = status.modelsDir, status.modelsDirExists else {
            throw PanoStitcherError.modelsNotInstalled(
                "Panorama models are not installed. Open Settings → Pano to download them, " +
                "or set the Models Directory to a folder containing \(PanoProvisioning.modelFilenameList)."
            )
        }
        PanoMLEnvironment.export(PanoProvisioningDefaults.modelsDirEnv, modelsDir.path)

        // iOS links ONNX Runtime statically (the `ml-static` Rust feature →
        // `ort::init()`, no dlopen), so there is no dylib to resolve and the
        // core never reads `ORT_DYLIB_PATH` there.
        #if os(macOS)
        guard let dylib = status.ortDylibPath, status.ortDylibExists else {
            throw PanoStitcherError.modelsNotInstalled(
                "ONNX Runtime is not installed. Open Settings → Pano to download it, or set " +
                "the ONNX Runtime Dylib Path to libonnxruntime.dylib (version ≥ 1.23)."
            )
        }
        // Load-time integrity for the AUTO-PROVISIONED dylib only. The app runs
        // with disable-library-validation and the dylib lives in a user-writable
        // location, so re-verify its pinned SHA-256 immediately before dlopen.
        // A Settings or launch-environment override is the user's own dylib.
        if status.ortDylibSource == .appSupport {
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
        PanoMLEnvironment.export(PanoProvisioningDefaults.ortDylibPathEnv, dylib.path)
        #endif
    }
}
