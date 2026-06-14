// RustPanoStitcher.swift — Real FFI-backed PanoStitching conformance (M4).
//
// Wraps `maple_pano_stitch` from RawPipeline.xcframework. The FFI call is a
// ~6-minute blocking operation and runs off the MainActor on a detached task.
//
// # Progress bridging  (fixed in #1239)
//
// The C callback `MaplePanoProgressFn` is `void(*)(uint32_t stage, float frac,
// void *user)`. We pass an `Unmanaged<ProgressAtom>` pointer as `cb_user`.
//
// The hot path is lock-free:
//   - The C trampoline (called from rayon worker threads, potentially from
//     multiple threads simultaneously) does ONLY: reconstruct the atom from
//     the opaque pointer, acquire `os_unfair_lock` for one word-store, release.
//     No Task allocation, no MainActor enqueue.
//   - A `ProgressPoller` Timer fires ~20×/sec on the main run loop, reads the
//     latest stored `(stage, fraction)`, and calls the `@MainActor` closure if
//     the value has changed.
//
// Ownership / lifetime:
//   1. `passRetained(_:)` bumps the atom's refcount before the FFI call.
//   2. The FFI (`maple_pano_stitch`) joins all rayon workers before returning.
//      After that point the trampoline is guaranteed NOT to run.
//   3. `release()` decrements the refcount unconditionally after the FFI returns
//      (no use-after-free possible — the join is the barrier).
//   4. The poller's final tick fires after the FFI returns (from `_runFFI`) to
//      emit the terminal stage/fraction to the UI regardless of poll timing.
//
// # Cancel
//
// `cancel()` flips a Rust-allocated `MapleCancelFlag` via `CancelFlag`. The
// same pattern is used by `PipelineRenderer.renderSceneLinear` (#951).
//
// # Models / ONNX Runtime provisioning
//
// The pipeline needs:
//   - ALIKED + LightGlue ONNX models  (Settings → Pano, MAPLE_PANO_MODELS env var, or app-support)
//   - ONNX Runtime dylib              (Settings → Pano, ORT_DYLIB_PATH env var, or app-support)
//
// Resolution order (via PanoProvisioning):
//   1. UserDefaults (Settings → Pano page — the user configured a path).
//   2. Process environment (MAPLE_PANO_MODELS / ORT_DYLIB_PATH — dev / CI).
//   3. Default app-support location.
//
// If none of the three tiers yields a path that exists on disk, `stitch`
// throws `PanoStitcherError.modelsNotInstalled` with a message that directs
// the user to Settings → Pano.
//
// follow-up: #1234 M6 — auto-download / bundle ONNX models + libonnxruntime
//   so users don't need to configure paths manually. iOS ORT provisioning
//   also deferred to M6 (FFI returns -3 on iOS today).
//
// Ticket: #1234 (M4+M5) / #1235 / #1239 / #1241

import Foundation
import OSLog
import RawPipeline

private let panoLog = Logger(subsystem: "app.justmaple.aperture", category: "RustPanoStitcher")

// MARK: - ProgressAtom

/// Lock-protected atom that stores the latest `(stage, fraction)` tick
/// received from the C trampoline.  The atom itself is heap-allocated and
/// passed through the C `cb_user` void pointer; its lifetime is managed by
/// `passRetained` / `release` in `_runFFI`.
///
/// `os_unfair_lock` is used because:
///   - It is async-signal–safe and callable from any thread including rayon
///     worker threads (unlike `NSLock` / `pthread_mutex`).
///   - The critical section is two word-stores — contention is negligible even
///     under parallel rayon calls.
///   - `Mutex<T>` from Swift Concurrency would require awaiting and cannot be
///     used from a synchronous C-ABI function.
// @unchecked because the lock guards all mutable state; Swift cannot verify
// that automatically, but the implementation is provably thread-safe.
private final class ProgressAtom: @unchecked Sendable {
    // os_unfair_lock must be heap-allocated and accessed via pointer.
    // We store it in a fixed slot and never move the ProgressAtom after init.
    private var lock: os_unfair_lock = .init()

    // Latest values; guarded by `lock`.
    private var _stage: UInt32 = 0
    private var _frac: Float = 0.0

    // Whether any tick has been stored at all (sentinel for "not yet started").
    private var _hasTick: Bool = false

    /// Store a new tick from the C trampoline.  Called from arbitrary threads.
    @inline(__always)
    func store(stage: UInt32, frac: Float) {
        os_unfair_lock_lock(&lock)
        _stage = stage
        _frac  = frac
        _hasTick = true
        os_unfair_lock_unlock(&lock)
    }

    /// Read the latest tick.  Returns `nil` if no tick has been stored yet.
    /// Called only from the main thread (poller timer).
    func load() -> (stage: UInt32, frac: Float)? {
        os_unfair_lock_lock(&lock)
        let has = _hasTick
        let s   = _stage
        let f   = _frac
        os_unfair_lock_unlock(&lock)
        return has ? (s, f) : nil
    }
}

// MARK: - C trampoline (free function — no method pointer round-trip)

/// C-ABI trampoline called by the Rust worker for each progress tick.
/// Reconstructs the `ProgressAtom` from `user` WITHOUT consuming the retain
/// (passUnretained) — the atom lifetime is managed by the balanced
/// `passRetained`/`release` pair in `_runFFI`.
///
/// HOT PATH: does NO Task allocation and NO MainActor enqueue.  It does only
/// one lock-acquire + two word-stores + lock-release.  Safe to call from
/// multiple rayon threads concurrently.
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
    Unmanaged<ProgressAtom>.fromOpaque(user).takeUnretainedValue().store(stage: stage, frac: frac)
}

// MARK: - ProgressPoller

/// Main-run-loop timer that reads the shared atom ~20×/sec and calls the
/// `@MainActor` progress closure when the value changes.
///
/// Lifecycle: created just before the FFI call, invalidated just after it
/// returns.  One final forced flush is done after invalidation so the terminal
/// stage/fraction always reaches the UI regardless of poll timing.
@MainActor
private final class ProgressPoller {
    private let atom: ProgressAtom
    private let closure: @MainActor (PanoStage, Double) -> Void
    private var timer: Timer?

    // Last value dispatched to the closure — used to suppress no-change ticks.
    private var lastStage: UInt32 = UInt32.max
    private var lastFrac: Float = -1.0

    init(atom: ProgressAtom, closure: @escaping @MainActor (PanoStage, Double) -> Void) {
        self.atom = atom
        self.closure = closure
    }

    /// Start polling.  Must be called from MainActor.
    func start() {
        // 50 ms interval → ~20 updates/sec (well inside human-perceptible latency).
        // scheduledTimer fires on the main run loop (same thread the MainActor
        // runs on); MainActor.assumeIsolated documents this invariant explicitly.
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.tick()
            }
        }
    }

    /// Stop polling and emit one final tick so the terminal state always
    /// reaches the UI.  Must be called from MainActor.
    func stop() {
        timer?.invalidate()
        timer = nil
        tick()   // flush terminal state unconditionally
    }

    // Reads the atom and dispatches if changed.
    private func tick() {
        guard let (s, f) = atom.load() else { return }
        // Suppress if unchanged (float equality is intentional: we stored the
        // exact bit pattern that came from Rust, so round-trip is exact).
        guard s != lastStage || f != lastFrac else { return }
        lastStage = s
        lastFrac  = f
        closure(PanoStage.fromFFIStage(s), Double(f))
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

    /// Resolves the two ML-runtime paths (models dir + ORT dylib).
    /// Priority: UserDefaults settings → env vars → default app-support.
    // Internal (not private) so RustPanoStitcher+MLEnvironment.swift can reach it.
    let provisioning: PanoProvisioning

    /// Cancel flag forwarded to the FFI so `cancel()` can interrupt a
    /// running stitch. Replaced on each new `stitch(...)` call so a
    /// stale flag from a previous run doesn't immediately cancel the next one.
    nonisolated(unsafe) private var cancelFlag: CancelFlag?

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

        // Shared atom: the C trampoline writes here lock-free; the poller
        // reads it on the main run loop.
        let atom = ProgressAtom()

        // Start the MainActor-side poller BEFORE the detached task begins.
        // We hop to the MainActor to create + start the timer, then hop back.
        let poller = await MainActor.run {
            let p = ProgressPoller(atom: atom, closure: progress)
            p.start()
            return p
        }

        // Run the blocking FFI off the main actor. Task.detached avoids
        // inheriting the @MainActor context (which would block it); the
        // closure is @Sendable because CancelFlag + URL + PanoOptions are all
        // Sendable.  We pass `atom` (not the progress closure) so no
        // @MainActor type crosses into the non-isolated detached context.
        do {
            let result = try await Task.detached(priority: .userInitiated) { [flag] () throws -> PanoResult in
                try Self._runFFI(
                    inputURLs: inputURLs,
                    outputURL: outputURL,
                    options: options,
                    atom: atom,
                    cancelFlag: flag
                )
            }.value
            // Stop and flush the poller after the FFI returns (hops to MainActor).
            await MainActor.run { poller.stop() }
            return result
        } catch {
            await MainActor.run { poller.stop() }
            throw error
        }
    }

    // MARK: - FFI invocation (static — no actor capture)

    /// All the actual FFI plumbing. Static so the detached Task doesn't
    /// capture `self` (no implicit @MainActor leak).
    ///
    /// `atom` is the shared `ProgressAtom` written by the C trampoline and
    /// read by the `ProgressPoller` running on the main run loop.  We retain
    /// it across the synchronous FFI call so the trampoline never reads a
    /// freed pointer.
    private static func _runFFI(
        inputURLs: [URL],
        outputURL: URL,
        options: PanoOptions,
        atom: ProgressAtom,
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

        // 4. Progress bridging — retain the atom across the synchronous FFI
        //    call; release unconditionally when it returns (the FFI joins all
        //    worker threads before returning, so the trampoline is guaranteed
        //    not to run after this point — no use-after-free).
        let retained = Unmanaged.passRetained(atom)
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
