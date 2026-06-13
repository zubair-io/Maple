// RustPanoStitcher.swift — Real FFI-backed PanoStitching conformance (M4).
//
// Wraps `maple_pano_stitch` from RawPipeline.xcframework. The FFI call is a
// ~6-minute blocking operation and runs off the MainActor on a detached task.
//
// # Progress bridging
//
// The C callback `MaplePanoProgressFn` is `void(*)(uint32_t stage, float frac,
// void *user)`. We pass an `Unmanaged<ProgressBox>` pointer as `cb_user`.
// `ProgressBox` captures the `@MainActor` Swift closure; the C trampoline
// function reconstructs the box from the opaque pointer and hops to MainActor
// to call the closure. Ownership:
//   1. `passRetained(_:)` bumps the refcount before the FFI call.
//   2. `release()` decrements it unconditionally after the FFI call returns
//      (the FFI joins all worker threads before returning, so the trampoline
//      is guaranteed not to run after this point).
//
// # Cancel
//
// `cancel()` flips a Rust-allocated `MapleCancelFlag` via `CancelFlag`. The
// same pattern is used by `PipelineRenderer.renderSceneLinear` (#951).
//
// # Models / ONNX Runtime provisioning
//
// The pipeline needs:
//   - ALIKED + LightGlue ONNX models  (MAPLE_PANO_MODELS env var or app-support)
//   - ONNX Runtime dylib              (ORT_DYLIB_PATH env var or app-support)
//
// Both env vars are read once at stitch-start and forwarded to the Rust core
// via `setenv`. If neither env var is set and the app-support path doesn't
// contain the files, the FFI returns -6 ("ML environment unavailable") and we
// throw `PanoStitcherError.modelsNotInstalled` with a clear message.
//
// A proper settings/download flow is a tracked follow-up (M6 of #1234). The
// bundling and on-device provisioning of the ONNX Runtime dylib on iOS is
// also deferred to M6 (the FFI returns -3 on iOS today).
//
// Ticket: #1234 (M4+M5) / #1235

import Foundation
import OSLog
import RawPipeline

private let panoLog = Logger(subsystem: "app.justmaple.aperture", category: "RustPanoStitcher")

// MARK: - ProgressBox

/// Heap-allocated context box passed through the C `cb_user` void pointer.
/// Captures the `@MainActor` Swift progress closure so the C trampoline
/// can hop back to MainActor and call it safely.
private final class ProgressBox {
    let progress: @MainActor (PanoStage, Double) -> Void

    init(_ progress: @escaping @MainActor (PanoStage, Double) -> Void) {
        self.progress = progress
    }
}

// MARK: - C trampoline (free function — no method pointer round-trip)

/// C-ABI trampoline called by the Rust worker for each progress tick.
/// Reconstructs the `ProgressBox` from `user` WITHOUT consuming the retain
/// (passUnretained) — the box lifetime is managed by the balanced
/// `passRetained`/`release` pair in `_runFFI`. Hops to MainActor and calls
/// the Swift closure.
///
/// Stage ordinals from `maple_pano::stitch` module docs:
///   0 = decode + priors
///   1 = ML load + proxy features
///   2 = match graph
///   3 = NCC refinement + reverification
///   4 = bundle adjustment + leveling
///   5 = composite
private func panoProgressTrampoline(stage: UInt32, frac: Float, user: UnsafeMutableRawPointer?) {
    guard let user else { return }
    let box = Unmanaged<ProgressBox>.fromOpaque(user).takeUnretainedValue()
    let swiftStage = PanoStage.fromFFIStage(stage)
    let fraction = Double(frac)
    // Hop to MainActor. The closure captures no actors and is @Sendable.
    Task { @MainActor in
        box.progress(swiftStage, fraction)
    }
}

// MARK: - RustPanoStitcher

/// Real FFI-backed `PanoStitching` conformance. Calls `maple_pano_stitch`
/// from `RawPipeline.xcframework` on a detached background task so the
/// ~6-minute blocking call never touches the MainActor.
///
/// Use this in production. The `MockPanoStitcher` is retained for unit tests.
public final class RustPanoStitcher: PanoStitching {
    // MARK: - State

    /// Directory containing the ALIKED + LightGlue ONNX model files.
    /// Resolved at init from env var → app-support fallback.
    private let modelsDir: URL?

    /// Path to the ONNX Runtime dylib (`libonnxruntime.dylib`).
    /// Resolved at init from env var → app-support fallback.
    private let ortDylibPath: URL?

    /// Cancel flag forwarded to the FFI so `cancel()` can interrupt a
    /// running stitch. Replaced on each new `stitch(...)` call so a
    /// stale flag from a previous run doesn't immediately cancel the next one.
    nonisolated(unsafe) private var cancelFlag: CancelFlag?

    // MARK: - Init

    public init() {
        self.modelsDir = Self.resolveModelsDir()
        self.ortDylibPath = Self.resolveOrtDylibPath()
    }

    // MARK: - PanoStitching

    public func cancel() {
        cancelFlag?.requestCancel()
    }

    public func stitch(
        assets: [AssetRef],
        options: PanoOptions,
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoResult {
        // Validate assets: pano needs file-backed images.
        let inputURLs = try collectInputURLs(from: assets)

        // Provision ML environment env vars so the Rust core finds the dylib
        // and models directory when it calls `ort::init_from(...)`.
        try provisionMLEnvironment()

        // Output path: a unique PNG next to the first input file's parent
        // (or in Application Support if we can't resolve one).
        let outputURL = makeOutputURL(near: inputURLs[0])

        // Fresh cancel flag for this run.
        let flag = CancelFlag()
        cancelFlag = flag

        // Run the blocking FFI off the main actor. Task.detached avoids
        // inheriting the @MainActor context (which would block it); the
        // closure is @Sendable because CancelFlag + URL + PanoOptions are all
        // Sendable.
        let result = try await Task.detached(priority: .userInitiated) { [flag] () throws -> PanoResult in
            try Self._runFFI(
                inputURLs: inputURLs,
                outputURL: outputURL,
                options: options,
                progress: progress,
                cancelFlag: flag
            )
        }.value

        return result
    }

    // MARK: - FFI invocation (static — no actor capture)

    /// All the actual FFI plumbing. Static so the detached Task doesn't
    /// capture `self` (no implicit @MainActor leak).
    private static func _runFFI(
        inputURLs: [URL],
        outputURL: URL,
        options: PanoOptions,
        progress: @escaping @MainActor (PanoStage, Double) -> Void,
        cancelFlag: CancelFlag
    ) throws -> PanoResult {
        // 1. Build C strings. `cStrings` is an array of [CChar] that lives on
        //    the stack for the duration of this function; `withCStringPointers`
        //    builds the pointer array inside nested `withUnsafeBufferPointer`
        //    closures so the base addresses stay valid.
        let cStrings: [[CChar]] = try inputURLs.map { url in
            guard let cs = url.path.cString(using: .utf8) else {
                throw PanoStitcherError.pathEncodingError(url)
            }
            return cs
        }

        // 2. Output path C string.
        guard let outCStr = outputURL.path.cString(using: .utf8) else {
            throw PanoStitcherError.pathEncodingError(outputURL)
        }

        // 3. Map Swift options → C enums.
        let retention: MaplePanoRetention = switch options.retention {
            case .keep:   Keep
            case .strict: Strict
        }
        let localAlign: MaplePanoLocalAlign = switch options.localAlign {
            case .mesh: Mesh
            case .off:  Off
        }
        let strategy: MaplePanoStrategy = switch options.strategy {
            case .auto:     Auto
            case .rotation: Rotation
            case .tile:     Tile
        }

        // 4. Progress bridging — retain the box across the synchronous FFI
        //    call; release unconditionally when it returns (the FFI joins all
        //    worker threads before returning).
        let box = ProgressBox(progress)
        let retained = Unmanaged.passRetained(box)
        let ctxPtr = retained.toOpaque()
        defer { retained.release() }

        // 5. Security-scoped access for each input.
        //    Batch-start all scopes before the call and stop them after.
        let scopes: [(URL, Bool)] = inputURLs.map { url in
            let started = url.startAccessingSecurityScopedResource()
            return (url, started)
        }
        defer {
            for (url, started) in scopes where started {
                url.stopAccessingSecurityScopedResource()
            }
        }

        panoLog.notice("maple_pano_stitch START: \(inputURLs.count) frames → \(outputURL.lastPathComponent, privacy: .public)")

        // 6. Call the FFI via the recursive helper that stacks
        //    `withUnsafeBufferPointer` closures so every base address stays
        //    valid for the duration of the synchronous call.
        let rc: Int32 = withCStringPointers(cStrings, accumulated: []) { ptrs in
            outCStr.withUnsafeBufferPointer { outPtr in
                var mutablePtrs = ptrs
                return mutablePtrs.withUnsafeMutableBufferPointer { ptrBuf in
                    maple_pano_stitch(
                        ptrBuf.baseAddress,
                        UInt(ptrs.count),
                        outPtr.baseAddress,
                        retention,
                        localAlign,
                        strategy,
                        panoProgressTrampoline,
                        ctxPtr,
                        cancelFlag.pointer
                    )
                }
            }
        }

        // 7. Interpret return code.
        if rc == 0 {
            panoLog.notice("maple_pano_stitch OK → \(outputURL.path, privacy: .private)")
            let summary = "Stitched \(inputURLs.count) frames using \(options.strategy.rawValue) strategy. " +
                          "Local align: \(options.localAlign.rawValue). Retention: \(options.retention.rawValue). " +
                          "Output: \(outputURL.lastPathComponent)"
            return PanoResult(outputURL: outputURL, reportSummary: summary)
        }

        // Negative codes — extract the error message from thread-local storage.
        let errMsg = maple_last_error().map { String(cString: $0) } ?? "unknown error (rc \(rc))"
        panoLog.error("maple_pano_stitch FAILED rc=\(rc): \(errMsg, privacy: .public)")

        switch rc {
        case -3:
            throw PanoStitcherError.unsupportedPlatform
        case -6:
            throw PanoStitcherError.modelsNotInstalled(errMsg)
        default:
            throw PanoStitcherError.stitchFailed(code: Int(rc), message: errMsg)
        }
    }

    // MARK: - C string pointer helper

    /// Recursively build a stack-safe `[UnsafePointer<CChar>?]` by nesting
    /// `withUnsafeBufferPointer` closures — each level keeps one `[CChar]`
    /// pinned on the stack while the next level recurses. When all strings
    /// are accumulated, calls `body` with the complete pointer array.
    ///
    /// This avoids the unsafe pattern of calling `withUnsafeBufferPointer`
    /// and storing `baseAddress` outside the closure (where it would be a
    /// dangling pointer after the closure exits).
    private static func withCStringPointers<R>(
        _ strings: [[CChar]],
        accumulated: [UnsafePointer<CChar>?],
        body: ([UnsafePointer<CChar>?]) -> R
    ) -> R {
        if strings.isEmpty {
            return body(accumulated)
        }
        return strings[0].withUnsafeBufferPointer { ptr in
            var next = accumulated
            next.append(ptr.baseAddress)
            return withCStringPointers(Array(strings.dropFirst()), accumulated: next, body: body)
        }
    }

    // MARK: - Asset path extraction

    /// Collect file-backed URLs from the asset list, sorted by filename
    /// (capture order — mirrors the CLI convention). Throws if any asset
    /// lacks a `primaryURL` (bytes-only assets from PhotoKit / cloud are not
    /// supported at this milestone; a bytes-variant FFI is a follow-up).
    private func collectInputURLs(from assets: [AssetRef]) throws -> [URL] {
        var urls: [URL] = []
        for asset in assets {
            guard let url = asset.primaryURL else {
                // M6: a bytes-backed FFI entry would be needed here (PhotoKit
                // / cloud assets don't expose a filesystem URL). For now,
                // surface a clear error instead of silently dropping the asset.
                panoLog.error("Asset \(asset.displayName, privacy: .public) has no primaryURL — panorama requires file-backed images")
                throw PanoStitcherError.assetNotFileBacked(asset.displayName)
            }
            urls.append(url)
        }
        // Sort by filename to match capture order (mirrors CLI / maple-pano spec §8).
        urls.sort { $0.lastPathComponent < $1.lastPathComponent }
        return urls
    }

    // MARK: - Output URL

    /// Writes the panorama PNG into a `Panoramas/` subdirectory next to the
    /// first input file's parent. Falls back to Application Support if the
    /// directory isn't writable. NEVER touches or overwrites source RAWs.
    private func makeOutputURL(near firstInput: URL) -> URL {
        let parentDir = firstInput.deletingLastPathComponent()
        let panoDir = parentDir.appendingPathComponent("Panoramas", isDirectory: true)
        try? FileManager.default.createDirectory(at: panoDir, withIntermediateDirectories: true)

        // Verify the directory is writable; fall back to Application Support
        // if sandbox or read-only filesystem blocks it.
        let isWritable = FileManager.default.isWritableFile(atPath: panoDir.path)
        let targetDir: URL
        if isWritable {
            targetDir = panoDir
        } else {
            let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
                .appendingPathComponent("app.justmaple.aperture/Panoramas", isDirectory: true)
            try? FileManager.default.createDirectory(at: appSupport, withIntermediateDirectories: true)
            targetDir = appSupport
        }

        let name = "panorama-\(Int(Date().timeIntervalSince1970)).png"
        return targetDir.appendingPathComponent(name)
    }

    // MARK: - ML environment provisioning

    /// Set `MAPLE_PANO_MODELS` and `ORT_DYLIB_PATH` in the process environment
    /// so the Rust `maple_pano` crate can locate the ONNX Runtime dylib and
    /// model files. Reads from:
    ///   1. Environment variables already set by the caller (dev workflow).
    ///   2. Resolved paths from `resolveModelsDir()` / `resolveOrtDylibPath()`.
    ///
    /// Throws `PanoStitcherError.modelsNotInstalled` if neither source yields
    /// a usable path. A proper settings/download flow for end users is
    /// tracked as M6 of #1234.
    private func provisionMLEnvironment() throws {
        // Models dir
        if ProcessInfo.processInfo.environment["MAPLE_PANO_MODELS"] == nil {
            guard let dir = modelsDir, FileManager.default.fileExists(atPath: dir.path) else {
                throw PanoStitcherError.modelsNotInstalled(
                    "Panorama models not installed. Set MAPLE_PANO_MODELS to the directory " +
                    "containing aliked.onnx and lightglue.onnx, or place them in " +
                    "~/Library/Application Support/app.justmaple.aperture/pano-models/. " +
                    "(Model bundling and download UI: M6 of #1234.)"
                )
            }
            setenv("MAPLE_PANO_MODELS", dir.path, 1)
        }

        // ORT dylib path
        if ProcessInfo.processInfo.environment["ORT_DYLIB_PATH"] == nil {
            guard let dylib = ortDylibPath, FileManager.default.fileExists(atPath: dylib.path) else {
                throw PanoStitcherError.modelsNotInstalled(
                    "ONNX Runtime dylib not found. Set ORT_DYLIB_PATH to the " +
                    "libonnxruntime.dylib path (≥ 1.23), or place it in " +
                    "~/Library/Application Support/app.justmaple.aperture/ort/. " +
                    "(ORT bundling: M6 of #1234.)"
                )
            }
            setenv("ORT_DYLIB_PATH", dylib.path, 1)
        }
    }

    // MARK: - Path resolution

    /// Resolve the models directory. Priority:
    ///   1. `MAPLE_PANO_MODELS` environment variable (dev).
    ///   2. `~/Library/Application Support/app.justmaple.aperture/pano-models/`.
    private static func resolveModelsDir() -> URL? {
        if let envVal = ProcessInfo.processInfo.environment["MAPLE_PANO_MODELS"],
           !envVal.isEmpty {
            return URL(fileURLWithPath: envVal, isDirectory: true)
        }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("app.justmaple.aperture/pano-models", isDirectory: true)
    }

    /// Resolve the ORT dylib path. Priority:
    ///   1. `ORT_DYLIB_PATH` environment variable (dev).
    ///   2. `~/Library/Application Support/app.justmaple.aperture/ort/libonnxruntime.dylib`.
    private static func resolveOrtDylibPath() -> URL? {
        if let envVal = ProcessInfo.processInfo.environment["ORT_DYLIB_PATH"],
           !envVal.isEmpty {
            return URL(fileURLWithPath: envVal)
        }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("app.justmaple.aperture/ort/libonnxruntime.dylib")
    }
}

// MARK: - PanoStage + FFI stage mapping

extension PanoStage {
    /// Map C ABI stage ordinals → `PanoStage`.
    ///
    /// Ordinals from `maple_pano::stitch` module docs:
    ///   0 = decode + priors         → .decoding
    ///   1 = ML + proxy features     → .matching (feature extraction is part of matching)
    ///   2 = match graph             → .graph
    ///   3 = NCC refinement          → .solving  (refinement feeds the solver)
    ///   4 = bundle adjustment       → .localAlign (BA + leveling → local correction)
    ///   5 = composite               → .compositing
    ///
    /// No explicit `writing` stage is emitted by the FFI; the protocol
    /// definition reserves `.writing` for future use.
    static func fromFFIStage(_ stage: UInt32) -> PanoStage {
        switch stage {
        case 0: return .decoding
        case 1: return .matching
        case 2: return .graph
        case 3: return .solving
        case 4: return .localAlign
        case 5: return .compositing
        default: return .compositing   // forward-compat: unknown future stages map to compositing
        }
    }
}

// MARK: - PanoStitcherError

public enum PanoStitcherError: Error, LocalizedError {
    case pathEncodingError(URL)
    case assetNotFileBacked(String)
    case modelsNotInstalled(String)
    case unsupportedPlatform
    case stitchFailed(code: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .pathEncodingError(let url):
            return "Cannot encode path as UTF-8: \(url.path)"
        case .assetNotFileBacked(let name):
            return "Panorama requires file-backed images. '\(name)' is a cloud or PhotoKit asset — " +
                   "download it to local storage first. (Bytes-variant FFI: M6 of #1234.)"
        case .modelsNotInstalled(let msg):
            return msg
        case .unsupportedPlatform:
            return "Panorama stitching is not yet supported on this platform. (iOS support: M6 of #1234.)"
        case .stitchFailed(let code, let message):
            return "Panorama stitch failed (code \(code)): \(message)"
        }
    }
}
