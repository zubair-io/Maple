// PanoBackgroundPause.swift — lets a panorama stitch ask the host to stop its
// other memory-heavy work (the PhotoKit backup) for as long as the stitch runs.
//
// Ticket: #5653

import Foundation
import os

/// Held by a stitch while it runs; the work it paused resumes when the last
/// holder lets go. Released at most once, and on deinit if nobody did, so an
/// abandoned stitch can never leave the host paused.
public final class PanoBackgroundPause: Sendable {
    /// The host had work running that this pause stopped, so the memory the
    /// stitch sizes itself against has changed since the sheet read it.
    public let stoppedRunningWork: Bool
    private let onRelease: OSAllocatedUnfairLock<(@Sendable () -> Void)?>

    public init(stoppedRunningWork: Bool, onRelease: @escaping @Sendable () -> Void) {
        self.stoppedRunningWork = stoppedRunningWork
        self.onRelease = OSAllocatedUnfairLock(initialState: onRelease)
    }

    public func release() {
        let action = onRelease.withLock { handler -> (@Sendable () -> Void)? in
            defer { handler = nil }
            return handler
        }
        action?()
    }

    deinit { release() }
}

/// The host side of a stitch's pause. `pause()` returns once the work is
/// actually stopped.
public protocol PanoBackgroundPausing: Sendable {
    func pause() async -> PanoBackgroundPause
}
