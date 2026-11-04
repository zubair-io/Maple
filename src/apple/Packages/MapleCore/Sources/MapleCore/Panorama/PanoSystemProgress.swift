// PanoSystemProgress.swift — run state to system-progress events (#5663).

import Foundation

public struct PanoSystemProgressTracker: Sendable {
    public static let totalUnits = 1000

    public struct Frame: Equatable, Sendable {
        public let units: Int
        public let subtitle: String
    }

    public enum Outcome: Equatable, Sendable {
        case finished
        case failed(String)
        case stopped
    }

    public enum Event: Equatable, Sendable {
        case began(Frame)
        case progressed(Frame)
        case ended(Outcome)
    }

    private var lastFrame: Frame?

    public init() {}

    public mutating func consume(
        _ state: PanoMergeSession.RunState, progress: PanoStitchProgress?
    ) -> Event? {
        switch state {
        case .finishingAlignment, .running:
            guard let progress else { return nil }
            return advance(to: frame(for: state, progress: progress))
        case .idle:
            return end(.stopped)
        case .done:
            return end(.finished)
        case .error(let error):
            return end(.failed(error.message))
        }
    }

    private func frame(for state: PanoMergeSession.RunState, progress: PanoStitchProgress) -> Frame {
        let title = progress.title.replacingOccurrences(of: "…", with: "")
        guard case .running = state else { return Frame(units: 0, subtitle: title) }
        let fraction = progress.fraction.isFinite ? min(max(progress.fraction, 0), 1) : 0
        let percent = Int(fraction * 100)
        return Frame(units: percent * 10, subtitle: "\(title) · \(percent)%")
    }

    private mutating func advance(to frame: Frame) -> Event? {
        let previous = lastFrame
        guard frame != previous else { return nil }
        lastFrame = frame
        return previous == nil ? .began(frame) : .progressed(frame)
    }

    private mutating func end(_ outcome: Outcome) -> Event? {
        guard lastFrame != nil else { return nil }
        lastFrame = nil
        return .ended(outcome)
    }
}
