// PanoMergeSession.swift — Observable state for a panorama merge.
//
// Owns two independent lifecycles:
//   preview:  idle → running → ready | failed   (automatic, re-run on option change)
//   stitch:   idle → running → done | error      (the user's "Create Panorama")
//
// The preview's solved alignment is held here, in memory, and offered to
// every later preview and to the full stitch so matching is not repeated.
//
// Generation-counter discipline (per docs/best-practices.md §"Generation
// counters for async state") ensures that a cancelled or superseded run can
// never publish stale progress or results.
//
// Ticket: #1236 / Part of #1234 / #4579

import Foundation

// MARK: - PanoMergeSession

@MainActor
@Observable
public final class PanoMergeSession {
    // MARK: - State machine

    /// Sendable error carrier for the `.error` / `.failed` states.
    ///
    /// `Error` is not guaranteed `Sendable`, so the enum cannot store an
    /// arbitrary `Error` and correctly claim `Sendable` conformance. Views
    /// only need the message text.
    public struct StitchError: Sendable {
        /// The `localizedDescription` of the underlying error.
        public let message: String

        public init(underlying: any Error) {
            self.message = underlying.localizedDescription
        }
    }

    public enum RunState: Sendable {
        case idle
        /// Create Panorama was pressed while a preview was matching; the
        /// stitch starts from that preview's alignment once it lands.
        case finishingAlignment
        case running(stage: PanoStage, stageFraction: Double, overallFraction: Double)
        case done(result: PanoResult)
        case error(StitchError)
    }

    public enum PreviewState: Sendable {
        case idle
        /// Waiting out the debounce after an option change.
        case scheduled
        case running(stage: PanoStage, overallFraction: Double)
        case ready
        case failed(StitchError)
    }

    public private(set) var state: RunState = .idle
    public private(set) var previewState: PreviewState = .idle

    /// The latest finished preview for the current frames. Stays visible
    /// while a re-preview runs, so an option change doesn't blank the view.
    public private(set) var lastPreview: PanoPreview?

    /// The most recent solved alignment, offered to the next preview and the
    /// full stitch of the same frames. Kept even when a later preview fails:
    /// the core rejects a mismatched alignment itself, so offering it is
    /// always safe. Dropped when other frames are previewed, which it could
    /// never match.
    public private(set) var alignment: PanoAlignment?
    private var alignmentFrames: [AssetRef.ID] = []

    /// How cloud-only frames can still stitch on this device: download them
    /// first (#5489). `nil` when the frames are not on a Maple server.
    public var downloadRoute: PanoDownloadRoute?

    /// True while a stitch is in-flight. Derived from `state` so views don't
    /// need a switch to drive a spinner.
    public var isRunning: Bool {
        switch state {
        case .running, .finishingAlignment: return true
        case .idle, .done, .error: return false
        }
    }

    public var isPreviewing: Bool {
        switch previewState {
        case .scheduled, .running: return true
        case .idle, .ready, .failed: return false
        }
    }

    // MARK: - Options (mutable before/after a run; not during)

    /// Changing an option while a preview is active re-runs it. A change to
    /// the geometry the alignment is keyed on cancels the run in flight and
    /// re-runs after `previewDebounce`; a composite-only change (retention,
    /// local alignment) lets the running preview finish its matching, then
    /// re-previews from that alignment with the new options.
    public var options: PanoOptions = .default {
        didSet {
            guard options != oldValue, previewAssets.count >= 2, !isRunning else { return }
            if case .running = previewState, previewRunStrategy == options.strategy {
                rePreviewWhenCurrentFinishes = true
                return
            }
            schedulePreview(after: previewDebounce)
        }
    }

    // MARK: - Output size (#5454)

    /// The output size the next stitch uses: the user's choice, else
    /// `.fitted` whenever a smaller output is on offer. Always `.full` when
    /// it is not, so the merge sheet never selects an option it isn't showing.
    public var outputSize: PanoOutputSize {
        get {
            guard case .fitted = memoryFit else { return .full }
            return chosenOutputSize ?? .fitted
        }
        set { chosenOutputSize = newValue }
    }

    /// How the full stitch of the latest preview fits this device's memory,
    /// read once when that preview lands so the sheet and the stitch agree;
    /// `nil` before a preview, or where the platform has no per-process
    /// memory limit (macOS). After a geometry change it describes the
    /// previous geometry until the new preview lands; `start` previews the
    /// current geometry first rather than stitch against it.
    public private(set) var memoryFit: PanoMemoryFit? {
        didSet { if memoryFit == nil { memoryFitOptions = nil } }
    }

    /// The canvas cap the next stitch will run with, `nil` for the default.
    public var outputCanvasCap: Int? {
        guard outputSize == .fitted, case .fitted(_, let pixels, _, _) = memoryFit else { return nil }
        return pixels
    }

    // MARK: - Private

    public private(set) var stitcher: any PanoStitching
    private let memoryModel = PanoMemoryModel()
    private let availableMemory: @Sendable () -> Int?
    private var chosenOutputSize: PanoOutputSize?
    /// Options the latest finished preview, and so `memoryFit`, was solved
    /// for. Every option reaches the solver (retention and local alignment
    /// decide which frames survive), so any of them can change the canvas.
    private var memoryFitOptions: PanoOptions?
    private let previewDebounce: Duration
    private var runGeneration: UInt64 = 0
    private var previewGeneration: UInt64 = 0
    private var previewTask: Task<Void, Never>?
    /// The latest stitch run; the next one waits for it to unwind so two
    /// full stitches never hold their canvases at once.
    private var runTask: Task<Void, Never>?
    private var previewAssets: [AssetRef] = []
    /// Geometry option the in-flight preview run solves for.
    private var previewRunStrategy: PanoOptions.Strategy?
    /// A composite-only option changed while a preview was matching.
    private var rePreviewWhenCurrentFinishes = false

    public init(
        stitcher: any PanoStitching,
        previewDebounce: Duration = .milliseconds(600),
        availableMemory: @escaping @Sendable () -> Int? = { PanoAvailableMemory.current() }
    ) {
        self.stitcher = stitcher
        self.previewDebounce = previewDebounce
        self.availableMemory = availableMemory
    }

    // MARK: - Preview API

    /// Start the automatic preview for `assets` immediately. Later option
    /// changes re-run it (debounced) until `cancel()` or a stitch starts.
    /// Fewer than two frames clears the preview. Ignored while a stitch
    /// runs: a preview beside it would compete for the same memory.
    public func preview(assets: [AssetRef]) {
        guard !isRunning else { return }
        if assets.map(\.id) != alignmentFrames { alignment = nil }
        if assets.map(\.id) != previewAssets.map(\.id) {
            lastPreview = nil
            memoryFit = nil
            chosenOutputSize = nil
        }
        previewAssets = assets
        guard assets.count >= 2 else {
            cancelPreview()
            return
        }
        schedulePreview(after: .zero)
    }

    private func schedulePreview(after delay: Duration) {
        rePreviewWhenCurrentFinishes = false
        let superseded = previewTask
        superseded?.cancel()
        let unwinding = [superseded, runTask].compactMap { $0 }
        previewGeneration &+= 1
        let gen = previewGeneration
        let assets = previewAssets
        let capturedStitcher = stitcher
        previewState = delay == .zero ? .running(stage: .decoding, overallFraction: 0) : .scheduled

        previewTask = Task { [weak self] in
            for task in unwinding { await task.value }
            if delay > .zero {
                do { try await Task.sleep(for: delay) } catch { return }
            }
            guard let self, self.previewGeneration == gen else { return }
            let capturedOptions = self.options
            self.previewRunStrategy = capturedOptions.strategy
            self.previewState = .running(stage: .decoding, overallFraction: 0)
            do {
                let preview = try await capturedStitcher.preview(
                    assets: assets,
                    options: capturedOptions,
                    alignment: self.alignment,
                    progress: { [weak self] stage, stageFraction in
                        guard let self, self.previewGeneration == gen else { return }
                        let overall = PanoProgressWeights.preview.overall(stage: stage, stageFraction: stageFraction)
                        self.previewState = .running(stage: stage, overallFraction: overall)
                    }
                )
                guard self.previewGeneration == gen else { return }
                self.adopt(preview, of: assets, solvedFor: capturedOptions)
                self.previewState = .ready
            } catch is CancellationError {
                return
            } catch {
                guard self.previewGeneration == gen else { return }
                self.previewState = .failed(StitchError(underlying: error))
            }
            if self.rePreviewWhenCurrentFinishes {
                self.schedulePreview(after: .zero)
            }
        }
    }

    private func adopt(_ preview: PanoPreview, of assets: [AssetRef], solvedFor options: PanoOptions) {
        alignment = preview.alignment
        alignmentFrames = assets.map(\.id)
        lastPreview = preview
        memoryFit = preview.stitchSizes.flatMap {
            memoryModel.fit(sizes: $0, availableBytes: availableMemory())
        }
        memoryFitOptions = options
    }

    /// On a device with a per-process memory limit, the stitch must not size
    /// itself from a fit solved for other options: a `.fullFits` from them
    /// would pass no cap at all, and a fitted cap budgets their canvas's
    /// width. A stitch that runs elsewhere has no such limit to fit.
    private func needsFreshFit(for options: PanoOptions) -> Bool {
        stitcher.runsInDeviceMemory && memoryFitOptions != options && availableMemory() != nil
    }

    /// The running preview whose alignment Create Panorama should wait for:
    /// one already matching for the current geometry. A pending (debounced)
    /// re-preview has nothing in flight worth keeping.
    private var previewWorthAwaiting: Task<Void, Never>? {
        guard case .running = previewState, previewRunStrategy == options.strategy else { return nil }
        return previewTask
    }

    private func cancelPreview() {
        rePreviewWhenCurrentFinishes = false
        previewGeneration &+= 1
        previewTask?.cancel()
        previewState = .idle
    }

    // MARK: - Stitch API

    /// Start the full stitch with the given ordered asset list, offering the
    /// preview's alignment. A preview already matching for the current
    /// geometry is waited for (`.finishingAlignment`) so its matching is not
    /// thrown away; a pending re-preview is cancelled. A finished preview
    /// stays visible.
    ///
    /// A run already in flight is cancelled first, and the new one waits for
    /// it and any cancelled preview to unwind before stitching, so the
    /// cancelled run's state never overwrites the new run's and two stitches
    /// never run at once.
    public func start(assets: [AssetRef]) {
        guard assets.count >= 2 else { return }

        let awaitedPreview = previewWorthAwaiting
        rePreviewWhenCurrentFinishes = false
        if awaitedPreview == nil {
            if isPreviewing { cancelPreview() }
            stitcher.cancel()
        }
        runTask?.cancel()
        let unwinding = [runTask, previewTask].compactMap { $0 }

        runGeneration &+= 1
        let gen = runGeneration
        let capturedStitcher = stitcher
        let capturedOptions = options
        let weights = PanoProgressWeights.stitch(localAlign: capturedOptions.localAlign)

        state = awaitedPreview == nil
            ? .running(stage: .decoding, stageFraction: 0.0, overallFraction: 0.0)
            : .finishingAlignment

        runTask = Task {
            for task in unwinding { await task.value }
            guard runGeneration == gen else { return }
            do {
                if needsFreshFit(for: capturedOptions) {
                    state = .finishingAlignment
                    let preview = try await capturedStitcher.preview(
                        assets: assets, options: capturedOptions, alignment: alignment, progress: { _, _ in })
                    guard runGeneration == gen else { return }
                    adopt(preview, of: assets, solvedFor: capturedOptions)
                    previewState = .ready
                }
                state = .running(stage: .decoding, stageFraction: 0.0, overallFraction: 0.0)
                let result = try await capturedStitcher.stitch(
                    assets: assets,
                    options: capturedOptions,
                    alignment: alignment,
                    maxCanvasPixels: outputCanvasCap,
                    progress: { stage, stageFraction in
                        guard self.runGeneration == gen else { return }
                        self.state = .running(
                            stage: stage,
                            stageFraction: stageFraction,
                            overallFraction: weights.overall(stage: stage, stageFraction: stageFraction)
                        )
                    }
                )
                guard runGeneration == gen else { return }
                state = .done(result: result)
            } catch is CancellationError {
                // Superseded by a later `start` or `cancel()`, which already
                // set its own state.
            } catch {
                guard runGeneration == gen else { return }
                state = .error(StitchError(underlying: error))
            }
        }
    }

    /// Run later previews and stitches with `stitcher` — the merge sheet's
    /// "Run on server" choice (#5488). Whatever is in flight stops, and the
    /// alignment is dropped: one stitcher cannot reuse another's.
    public func use(_ stitcher: any PanoStitching) {
        guard stitcher !== self.stitcher else { return }
        let assets = previewAssets
        cancel()
        alignment = nil
        self.stitcher = stitcher
        preview(assets: assets)
    }

    /// Cancel the in-flight stitch and preview and return to idle. The
    /// alignment is kept so reopening the same frames can reuse it.
    public func cancel() {
        runGeneration &+= 1   // invalidate the in-flight progress callbacks
        runTask?.cancel()
        stitcher.cancel()
        state = .idle
        previewAssets = []
        lastPreview = nil
        memoryFit = nil
        cancelPreview()
    }

    /// Reset to idle after a done/error state so the user can adjust options
    /// and start again.
    public func reset() {
        guard !isRunning else { return }
        state = .idle
    }
}

// MARK: - PanoProgressWeights

/// Maps (stage, fraction-within-stage) to a 0–1 overall fraction. Weights
/// follow measured stage time on pano_01: matching dominates the preview,
/// compositing the full stitch.
struct PanoProgressWeights {
    let weights: [(PanoStage, Double)]

    static let preview = PanoProgressWeights(weights: [
        (.decoding,    0.10),
        (.matching,    0.15),
        (.graph,       0.55),
        (.solving,     0.00),  // refinement is skipped and reported complete at once
        (.localAlign,  0.10),
        (.compositing, 0.10),
    ])

    static func stitch(localAlign: PanoOptions.LocalAlign) -> PanoProgressWeights {
        localAlign == .mesh
            ? PanoProgressWeights(weights: [
                (.decoding,    0.20),
                (.matching,    0.15),
                (.graph,       0.05),
                (.solving,     0.15),
                (.localAlign,  0.10),
                (.compositing, 0.30),
                (.writing,     0.05),
            ])
            : PanoProgressWeights(weights: [
                (.decoding,    0.20),
                (.matching,    0.15),
                (.graph,       0.05),
                (.solving,     0.20),
                (.compositing, 0.35),
                (.writing,     0.05),
            ])
    }

    func overall(stage: PanoStage, stageFraction: Double) -> Double {
        guard let index = weights.firstIndex(where: { $0.0 == stage }) else {
            return weights.reduce(0) { $0 + $1.1 }
        }
        let base = weights[..<index].reduce(0) { $0 + $1.1 }
        return base + weights[index].1 * stageFraction
    }
}
