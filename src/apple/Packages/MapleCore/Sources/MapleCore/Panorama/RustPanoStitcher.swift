// RustPanoStitcher.swift — Real FFI-backed PanoStitching conformance (M4).
//
// Wraps `maple_pano_stitch_aligned` and `maple_pano_preview` from
// RawPipeline.xcframework (argument marshalling in PanoFFICall.swift). Both
// are long blocking calls — a full stitch takes minutes, a preview of a
// 21-frame set can take more than two — so they run off the MainActor on a
// detached task.
//
// # Progress bridging  (fixed in #1239)
//
// The C callback `MaplePanoProgressFn` writes into a lock-protected
// `PanoProgressAtom`; a ~20 Hz `PanoProgressPoller` on the main run loop forwards
// changes to the `@MainActor` closure (PanoProgressBridge.swift). No Task
// allocation or MainActor hop happens on the rayon worker threads.
//
// # Cancel
//
// Each run gets a fresh Rust-allocated `MapleCancelFlag` via `CancelFlag`.
// It is set by `cancel()` or by cancelling the calling Swift task, so the
// session can abandon a superseded preview without a shared flag.
//
// # Models / ONNX Runtime provisioning
//
// The opt-in ML matcher (#4554) needs:
//   - ALIKED + LightGlue ONNX models  (Settings → Pano, MAPLE_PANO_MODELS env var, or app-support)
//   - ONNX Runtime dylib              (Settings → Pano, ORT_DYLIB_PATH env var, or app-support)
//
// Resolution order (via PanoProvisioning):
//   1. UserDefaults (Settings → Pano page — the user configured a path).
//   2. Process environment (MAPLE_PANO_MODELS / ORT_DYLIB_PATH — dev / CI).
//   3. Default app-support location.
//
// The default classical matcher needs nothing on disk;
// `PanoProvisioning.featureEngine()` picks ML only when Settings → Pano
// turned it on and it is provisioned; preview and stitch resolve it the
// same way. An opted-in ML matcher that is missing or fails to load runs
// classical instead and reports `.classicalFallback` (#5487).
//
// Ticket: #1234 (M4+M5) / #1235 / #1239 / #1241 / #4554 / #4579

import Foundation
import OSLog
import RawPipeline

private let panoLog = Logger(subsystem: "app.justmaple.aperture", category: "RustPanoStitcher")

// MARK: - RustPanoStitcher

/// Real FFI-backed `PanoStitching` conformance. Calls `maple_pano_stitch`
/// from `RawPipeline.xcframework` on a detached background task so the
/// ~6-minute blocking call never touches the MainActor.
///
/// Use this in production. The `MockPanoStitcher` is retained for unit tests.
public final class RustPanoStitcher: PanoStitching {
    // MARK: - State

    /// Resolves the two ML-runtime paths (models dir + ORT dylib).
    /// Priority: UserDefaults settings → env vars → default app-support.
    // Internal (not private) so RustPanoStitcher+MLEnvironment.swift can reach it.
    let provisioning: PanoProvisioning

    /// Cancel flag forwarded to the FFI so `cancel()` can interrupt a
    /// running stitch. Replaced on each new `stitch(...)` call so a
    /// stale flag from a previous run doesn't immediately cancel the next one.
    nonisolated(unsafe) private var cancelFlag: CancelFlag?

    /// Why the core could not load the ML matcher, and the ML files it saw
    /// then. While those files are unchanged, later previews and stitches go
    /// straight to classical rather than decoding every frame twice; a
    /// re-download or a new path in Settings → Pano tries ML again.
    nonisolated(unsafe) private var mlLoadFailure: (environment: String, reason: String)?

    // MARK: - Init

    /// Creates a stitcher backed by the given provisioning resolver.
    /// The default resolver reads from `UserDefaults.standard`, so
    /// Settings → Pano values take effect immediately on the next stitch.
    ///
    /// Pass a custom `PanoProvisioning` in tests to inject controlled paths
    /// without touching process environment or UserDefaults.
    public init(provisioning: PanoProvisioning = PanoProvisioning()) {
        self.provisioning = provisioning
    }

    // MARK: - PanoStitching

    public func cancel() {
        cancelFlag?.requestCancel()
    }

    public func stitch(
        assets: [AssetRef],
        options: PanoOptions,
        alignment: PanoAlignment?,
        maxCanvasPixels: Int?,
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoResult {
        let inputURLs = try collectInputURLs(from: assets)
        let outputURL = makeOutputURL(near: inputURLs[0])
        let (outcome, matcher) = try await runWithFallback { engine in
            try await self.runOffMain(progress: progress) { atom, flag in
                try PanoFFICall.stitch(
                    inputURLs: inputURLs,
                    outputURL: outputURL,
                    options: options,
                    engine: engine,
                    alignment: alignment,
                    maxCanvasPixels: maxCanvasPixels,
                    atom: atom,
                    cancelFlag: flag
                )
            }
        }
        let summary = "Stitched \(inputURLs.count) frames with the \(matcher.engine.displayName) using \(options.strategy.rawValue) strategy. " +
                      "Local align: \(options.localAlign.rawValue). Retention: \(options.retention.rawValue). " +
                      "Output: \(outputURL.lastPathComponent). \(outcome.summary)"
        return PanoResult(outputURL: outputURL, reportSummary: summary, alignmentOutcome: outcome, matcher: matcher)
    }

    public func preview(
        assets: [AssetRef],
        options: PanoOptions,
        alignment: PanoAlignment?,
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoPreview {
        let inputURLs = try collectInputURLs(from: assets)
        let (preview, matcher) = try await runWithFallback { engine in
            try await self.runOffMain(progress: progress) { atom, flag in
                try PanoFFICall.preview(
                    inputURLs: inputURLs,
                    options: options,
                    engine: engine,
                    alignment: alignment,
                    atom: atom,
                    cancelFlag: flag
                )
            }
        }
        return preview.with(matcher: matcher)
    }

    private func runWithFallback<T>(
        _ body: (PanoFeatureEngine) async throws -> T
    ) async throws -> (T, PanoMatcherOutcome) {
        let planned = plannedMatcher()
        let (value, matcher) = try await Self.withMLFallback(planned, body: body)
        if planned == .used(.ml), case .classicalFallback(let reason) = matcher {
            rememberMLLoadFailure(reason)
        }
        return (value, matcher)
    }

    func rememberMLLoadFailure(_ reason: String) {
        mlLoadFailure = (provisioning.mlEnvironmentFingerprint(), reason)
    }

    /// The matcher this run starts with. The ML runtime's environment is only
    /// provisioned when the ML matcher was opted into (#4554).
    func plannedMatcher() -> PanoMatcherOutcome {
        guard provisioning.mlOptedIn else { return .used(.classical) }
        if let failure = mlLoadFailure, failure.environment == provisioning.mlEnvironmentFingerprint() {
            return .classicalFallback(reason: failure.reason)
        }
        guard provisioning.featureEngine() == .ml else {
            return Self.fallback(reason: "The ML models or ONNX Runtime are not installed.")
        }
        do {
            try provisionMLEnvironment()
            return .used(.ml)
        } catch {
            return Self.fallback(reason: error.localizedDescription)
        }
    }

    private static func fallback(reason: String) -> PanoMatcherOutcome {
        panoLog.notice("Using the classical matcher instead of ML: \(reason, privacy: .public)")
        return .classicalFallback(reason: reason)
    }

    /// Runs `body` with the planned engine; an ML run the core cannot load
    /// (`modelsNotInstalled`) re-runs once with the classical matcher.
    static func withMLFallback<T>(
        _ planned: PanoMatcherOutcome,
        body: (PanoFeatureEngine) async throws -> T
    ) async throws -> (T, PanoMatcherOutcome) {
        guard planned == .used(.ml) else { return (try await body(planned.engine), planned) }
        do {
            return (try await body(.ml), planned)
        } catch PanoStitcherError.modelsNotInstalled(let reason) {
            return (try await body(.classical), fallback(reason: reason))
        }
    }

    // MARK: - Off-main execution

    /// Runs a blocking pano FFI call on a detached task with progress polled
    /// onto the MainActor. Cancelling the calling task sets the Rust cancel
    /// flag, so the run stops at its next checkpoint and throws
    /// `CancellationError`.
    private func runOffMain<T: Sendable>(
        progress: @escaping @MainActor (PanoStage, Double) -> Void,
        body: @escaping @Sendable (PanoProgressAtom, CancelFlag) throws -> T
    ) async throws -> T {
        let flag = CancelFlag()
        cancelFlag = flag
        let atom = PanoProgressAtom()
        let poller = await MainActor.run {
            let p = PanoProgressPoller(atom: atom, closure: progress)
            p.start()
            return p
        }
        do {
            let value = try await withTaskCancellationHandler {
                try await Task.detached(priority: .userInitiated) { try body(atom, flag) }.value
            } onCancel: {
                flag.requestCancel()
            }
            await MainActor.run { poller.stop() }
            return value
        } catch {
            await MainActor.run { poller.stop() }
            if Task.isCancelled { throw CancellationError() }
            throw error
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
    case previewUndecodable

    public var errorDescription: String? {
        switch self {
        case .pathEncodingError(let url):
            return "Maple can’t read the location of '\(url.lastPathComponent)'."
        case .assetNotFileBacked(let name):
            return "'\(name)' isn’t stored on this device yet. Download it, then merge again."
        case .modelsNotInstalled(let msg):
            return msg
        case .unsupportedPlatform:
            return "Panorama merging isn’t available on this device."
        case .stitchFailed(_, let message):
            return "The panorama merge failed: \(message)"
        case .previewUndecodable:
            return "The panorama preview image could not be decoded."
        }
    }
}
