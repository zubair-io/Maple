// PanoSystemProgress.swift — run state to system-progress events (#5663).

import Foundation

public struct PanoSystemProgressTracker: Sendable {
    public static let totalUnits = 1000
    /// Reaching the total tells the system the task is complete, so a running
    /// stitch stops short of it; only `finished` completes the bar.
    static let runningCeilingUnits = 990

    public struct Frame: Equatable, Sendable {
        public let units: Int
        public let subtitle: String
    }

    public enum Outcome: Equatable, Sendable {
        case finished
        case failed(String)
        case stopped

        public var isFailure: Bool {
            if case .failed = self { return true }
            return false
        }
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
            return advance(to: frame(for: progress))
        case .idle:
            return end(.stopped)
        case .done:
            return end(.finished)
        case .error(let error):
            return end(.failed(error.message))
        }
    }

    private func frame(for progress: PanoStitchProgress) -> Frame {
        let title = progress.title.replacingOccurrences(of: "…", with: "")
        let fraction = progress.fraction.isFinite ? min(max(progress.fraction, 0), 1) : 0
        let units = max(Int(fraction * Double(Self.runningCeilingUnits)), lastFrame?.units ?? 0)
        return Frame(units: units, subtitle: "\(title) · \(units / 10)%")
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

/// Several merge sessions can exist at once (one per iPad window) but the
/// system shows one task, so the first run to begin owns it until it ends or
/// its session is released; other sessions' events are ignored.
public struct PanoSystemProgressArbiter<ID: Hashable & Sendable>: Sendable {
    private var trackers: [ID: PanoSystemProgressTracker] = [:]
    public private(set) var owner: ID?

    public init() {}

    public mutating func consume(
        _ id: ID, state: PanoMergeSession.RunState, progress: PanoStitchProgress?
    ) -> PanoSystemProgressTracker.Event? {
        var tracker = trackers[id] ?? PanoSystemProgressTracker()
        let event = tracker.consume(state, progress: progress)
        trackers[id] = tracker
        switch event {
        case .began where owner == nil:
            owner = id
            return event
        case .progressed where owner == id:
            return event
        case .ended where owner == id:
            owner = nil
            return event
        default:
            return nil
        }
    }

    public mutating func release(_ id: ID) -> PanoSystemProgressTracker.Event? {
        trackers[id] = nil
        guard owner == id else { return nil }
        owner = nil
        return .ended(.stopped)
    }
}
