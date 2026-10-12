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
        /// `true` when the underlying error was `PanoStitcherError.modelsNotInstalled`.
        /// The merge view uses this to show a "Configure in Settings → Pano" button
        /// instead of the generic "Try Again" button. (#1241)
        public let isModelsNotInstalled: Bool

        public init(underlying: any Error) {
            self.message = underlying.localizedDescription
            if let panoErr = underlying as? PanoStitcherError,
               case .modelsNotInstalled = panoErr {
                self.isModelsNotInstalled = true
            } else {
                self.isModelsNotInstalled = false
            }
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
    /// full stitch. Kept even when a later preview fails: the core rejects a
    /// mismatched alignment itself, so offering it is always safe.
    public private(set) var alignment: PanoAlignment?

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

    /// Changing an option while a preview is active re-runs it after
    /// `previewDebounce`, cancelling the one in flight.
    public var options: PanoOptions = .default {
        didSet {
            guard options != oldValue, previewAssets.count >= 2 else { return }
            schedulePreview(after: previewDebounce)
        }
    }

    // MARK: - Private

    private let stitcher: any PanoStitching
    private let previewDebounce: Duration
    private var runGeneration: UInt64 = 0
    private var previewGeneration: UInt64 = 0
    private var previewTask: Task<Void, Never>?
    private var previewAssets: [AssetRef] = []
    /// Geometry option the in-flight preview run solves for.
    private var previewRunStrategy: PanoOptions.Strategy?

    public init(stitcher: any PanoStitching, previewDebounce: Duration = .milliseconds(600)) {
        self.stitcher = stitcher
        self.previewDebounce = previewDebounce
    }

    // MARK: - Preview API

    /// Start the automatic preview for `assets` immediately. Later option
    /// changes re-run it (debounced) until `cancel()` or a stitch starts.
    /// Fewer than two frames clears the preview.
    public func preview(assets: [AssetRef]) {
        if assets.map(\.id) != previewAssets.map(\.id) { lastPreview = nil }
        previewAssets = assets
        guard assets.count >= 2 else {
            cancelPreview()
            return
        }
        schedulePreview(after: .zero)
    }

    private func schedulePreview(after delay: Duration) {
        previewTask?.cancel()
        previewGeneration &+= 1
        let gen = previewGeneration
        let assets = previewAssets
        let capturedStitcher = stitcher
        previewState = delay == .zero ? .running(stage: .decoding, overallFraction: 0) : .scheduled

        previewTask = Task { [weak self] in
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
                self.alignment = preview.alignment
                self.lastPreview = preview
                self.previewState = .ready
            } catch is CancellationError {
                return
            } catch {
                guard self.previewGeneration == gen else { return }
                self.previewState = .failed(StitchError(underlying: error))
            }
        }
    }

    /// The running preview whose alignment Create Panorama should wait for:
    /// one already matching for the current geometry. A pending (debounced)
    /// re-preview has nothing in flight worth keeping.
    private var previewWorthAwaiting: Task<Void, Never>? {
        guard case .running = previewState, previewRunStrategy == options.strategy else { return nil }
        return previewTask
    }

    private func cancelPreview() {
        previewGeneration &+= 1
        previewTask?.cancel()
        previewTask = nil
        previewState = .idle
    }

    // MARK: - Stitch API

    /// Start the full stitch with the given ordered asset list, offering the
    /// preview's alignment. A preview already matching for the current
    /// geometry is waited for (`.finishingAlignment`) so its matching is not
    /// thrown away; a pending re-preview is cancelled. A finished preview
    /// stays visible.
    ///
    /// If a run is already in-flight it is cancelled first (the cancelled run's
    /// state will NOT overwrite the new run's state — the generation counter
    /// prevents it).
    public func start(assets: [AssetRef]) {
        guard assets.count >= 2 else { return }

        let awaitedPreview = previewWorthAwaiting
        if awaitedPreview == nil {
            if isPreviewing { cancelPreview() }
            stitcher.cancel()
        }

        runGeneration &+= 1
        let gen = runGeneration
        let capturedStitcher = stitcher
        let capturedOptions = options
        let weights = PanoProgressWeights.stitch(localAlign: capturedOptions.localAlign)

        state = awaitedPreview == nil
            ? .running(stage: .decoding, stageFraction: 0.0, overallFraction: 0.0)
            : .finishingAlignment

        Task {
            if let awaitedPreview {
                await awaitedPreview.value
                guard runGeneration == gen else { return }
                state = .running(stage: .decoding, stageFraction: 0.0, overallFraction: 0.0)
            }
            do {
                let result = try await capturedStitcher.stitch(
                    assets: assets,
                    options: capturedOptions,
                    alignment: alignment,
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

    /// Cancel the in-flight stitch and preview and return to idle. The
    /// alignment is kept so reopening the same frames can reuse it.
    public func cancel() {
        runGeneration &+= 1   // invalidate the in-flight progress callbacks
        stitcher.cancel()
        state = .idle
        previewAssets = []
        lastPreview = nil
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
