// MuiMediaTransportMath.swift — pure transport math shared by
// MuiVideoPlayer and MuiAudioPlayer (unified-component-catalog.md §2.7).
// Mirrors the web reference's `media-transport.ts` free functions
// (`formatDuration`, `computeProgressPercent`, `computeSeekTime`).

import Foundation

enum MuiMediaTransportMath {
    /// Formats elapsed/duration seconds as `m:ss` (never `h:mm:ss` —
    /// Maple's transport clips are all sub-hour). Non-finite or negative
    /// input (not yet loaded) reads as `0:00`.
    static func formatDuration(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds)
        let mins = total / 60
        let secs = total % 60
        return "\(mins):\(String(format: "%02d", secs))"
    }

    /// Scrubber fill percentage (`0...100`) for the current playback
    /// position. `0` when there's no known duration yet. Clamped at both
    /// ends: a negative `currentTime` (not-yet-loaded metadata) reads as
    /// `0`, and a `currentTime` past `duration` (a stale readback before
    /// the transport's own end-of-clip clamp lands) reads as `100`, rather
    /// than handing the scrubber an out-of-range fill.
    static func progressPercent(currentTime: Double, duration: Double) -> Double {
        guard duration > 0 else { return 0 }
        let percent = (currentTime / duration) * 100
        return Swift.min(100, Swift.max(0, percent))
    }

    /// Converts a scrub-track tap/drag ratio (`0...1`, fraction across the
    /// track) into a target playback time, clamped to the track bounds.
    /// `nil` when there's no duration to seek within yet.
    static func seekTime(ratio: Double, duration: Double) -> Double? {
        guard duration > 0 else { return nil }
        let clamped = Swift.max(0, Swift.min(1, ratio))
        return clamped * duration
    }
}
