// PanoMergeSession.swift — Observable state for a panorama merge run.
//
// Owns the lifecycle of one stitch operation:
//   idle → running → done | error
//
// Generation-counter discipline (per docs/best-practices.md §"Generation
// counters for async state") ensures that a cancel + re-run can never
// publish stale progress from the abandoned task.
//
// Ticket: #1236 / Part of #1234

import Foundation

// MARK: - PanoMergeSession

@MainActor
@Observable
public final class PanoMergeSession {
    // MARK: - State machine

    public enum RunState: Sendable {
        case idle
        case running(stage: PanoStage, stageFraction: Double, overallFraction: Double)
        case done(result: PanoResult)
        case error(Error)
    }

    public private(set) var state: RunState = .idle

    /// True while a stitch is in-flight. Derived from `state` so views don't
    /// need a switch to drive a spinner.
    public var isRunning: Bool {
        if case .running = state { return true }
        return false
    }

    // MARK: - Options (mutable before/after a run; not during)

    public var options: PanoOptions = .default

    // MARK: - Private

    private let stitcher: any PanoStitching
    private var runGeneration: UInt64 = 0

    /// All stages in document order (constant — used for overall-progress math).
    private static let orderedStages = PanoStage.allCases

    public init(stitcher: any PanoStitching) {
        self.stitcher = stitcher
    }

    // MARK: - API

    /// Start a stitch with the given ordered asset list.
    ///
    /// If a run is already in-flight it is cancelled first (the cancelled run's
    /// state will NOT overwrite the new run's state — the generation counter
    /// prevents it).
    public func start(assets: [AssetRef]) {
        guard assets.count >= 2 else { return }

        // Cancel any in-flight run. We don't await — the stitcher is
        // responsible for checking its own cancellation flag promptly.
        stitcher.cancel()

        runGeneration &+= 1
        let gen = runGeneration
        let capturedStitcher = stitcher
        let capturedOptions = options

        state = .running(stage: .decoding, stageFraction: 0.0, overallFraction: 0.0)

        Task {
            do {
                let result = try await capturedStitcher.stitch(
                    assets: assets,
                    options: capturedOptions,
                    progress: { [weak self] stage, stageFraction in
                        guard let self, self.runGeneration == gen else { return }
                        let overall = Self.overallFraction(
                            stage: stage,
                            stageFraction: stageFraction,
                            localAlign: capturedOptions.localAlign
                        )
                        self.state = .running(
                            stage: stage,
                            stageFraction: stageFraction,
                            overallFraction: overall
                        )
                    }
                )
                guard runGeneration == gen else { return }
                state = .done(result: result)
            } catch is CancellationError {
                // Cancelled by a subsequent call to `start` or by `cancel()`.
                // Leave state alone — the new run has already set its own
                // initial `.running` state.
            } catch {
                guard runGeneration == gen else { return }
                state = .error(error)
            }
        }
    }

    /// Cancel the in-flight run and return to idle.
    public func cancel() {
        runGeneration &+= 1   // invalidate the in-flight progress callbacks
        stitcher.cancel()
        state = .idle
    }

    /// Reset to idle after a done/error state so the user can adjust options
    /// and start again.
    public func reset() {
        guard !isRunning else { return }
        state = .idle
    }

    // MARK: - Helpers

    /// Map (stage, stageFraction) to a 0–1 overall progress value.
    ///
    /// Weights: decoding ×N frames gets 20%, matching 15%, graph 5%,
    /// solving 15%, localAlign 10% (or redistributed if skipped),
    /// compositing 30%, writing 5%.
    private static func overallFraction(
        stage: PanoStage,
        stageFraction: Double,
        localAlign: PanoOptions.LocalAlign
    ) -> Double {
        // Stage weights (must sum to 1.0)
        let hasLocalAlign = (localAlign == .mesh)
        let weights: [(PanoStage, Double)] = {
            if hasLocalAlign {
                return [
                    (.decoding,    0.20),
                    (.matching,    0.15),
                    (.graph,       0.05),
                    (.solving,     0.15),
                    (.localAlign,  0.10),
                    (.compositing, 0.30),
                    (.writing,     0.05),
                ]
            } else {
                return [
                    (.decoding,    0.20),
                    (.matching,    0.15),
                    (.graph,       0.05),
                    (.solving,     0.20),  // absorbs localAlign weight
                    (.compositing, 0.35),
                    (.writing,     0.05),
                ]
            }
        }()

        var cumulativeBase: Double = 0.0
        var stageWeight: Double = 0.0
        for (s, w) in weights {
            if s == stage {
                stageWeight = w
                break
            }
            cumulativeBase += w
        }
        return cumulativeBase + stageWeight * stageFraction
    }
}
