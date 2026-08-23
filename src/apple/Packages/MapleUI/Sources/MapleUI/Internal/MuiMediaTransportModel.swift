// MuiMediaTransportModel.swift — the play/pause/seek/mm:ss transport state
// shared by MuiVideoPlayer and MuiAudioPlayer (unified-component-catalog.md
// §2.7). Mirrors the web reference's `MediaTransportBase`: every
// template-bound bit of state (`isPlaying`, `currentTime`, `duration`,
// formatted readouts) lives here once; each player view supplies only the
// platform-specific media surface around it.
//
// The model never talks to AVFoundation directly — it drives an injected
// `MuiTransportPlayerControlling` (real usage: `MuiAVPlayerTransportAdapter`
// wrapping an `AVPlayer`; tests: a fake that records calls) and is fed
// state back via `handle*` methods a real player's observers call. That
// split is what makes "play/pause/seek" unit-testable without booting
// AVFoundation or touching the network, the same way `MuiToastController`
// is tested against an injected clock instead of the real one.

import Foundation

/// The command surface a transport model drives. Real usage wraps an
/// `AVPlayer`; tests inject a fake that records calls instead.
protocol MuiTransportPlayerControlling: AnyObject {
    func play()
    func pause()
    func seek(to seconds: Double)
}

@MainActor
final class MuiMediaTransportModel: ObservableObject {
    @Published private(set) var isPlaying: Bool
    @Published private(set) var currentTime: Double
    @Published private(set) var duration: Double

    private let player: MuiTransportPlayerControlling

    init(
        player: MuiTransportPlayerControlling,
        currentTime: Double = 0,
        duration: Double = 0,
        isPlaying: Bool = false
    ) {
        self.player = player
        self.currentTime = currentTime
        self.duration = duration
        self.isPlaying = isPlaying
    }

    var progressPercent: Double {
        MuiMediaTransportMath.progressPercent(currentTime: currentTime, duration: duration)
    }

    var formattedCurrentTime: String { MuiMediaTransportMath.formatDuration(currentTime) }
    var formattedDuration: String { MuiMediaTransportMath.formatDuration(duration) }

    /// The transport button's action: plays if paused, pauses if playing.
    func togglePlay() {
        if isPlaying { player.pause() } else { player.play() }
    }

    /// A real player's play/pause-state observer calls this with the
    /// element's current `isPlaying` reading.
    func setPlaying(_ playing: Bool) {
        isPlaying = playing
    }

    /// End-of-media: stops and rewinds the readout, matching the web
    /// reference's `onEnded` (which only flips `playing` false — the
    /// element's own `currentTime` naturally settles at its duration, but
    /// Maple's transport always shows a rewound `0:00` after a clip ends,
    /// ready to play again).
    func handleEnded() {
        isPlaying = false
        currentTime = 0
    }

    /// A real player's "duration now known" observer calls this once
    /// metadata loads.
    func handleLoadedMetadata(duration: Double) {
        self.duration = duration.isFinite && duration >= 0 ? duration : 0
    }

    /// A real player's periodic time observer calls this on every tick.
    func handleTimeUpdate(currentTime: Double) {
        self.currentTime = currentTime
    }

    /// Converts a scrub-track tap/drag ratio into a seek command; no-ops
    /// when there's no duration to seek within yet.
    func seek(toRatio ratio: Double) {
        guard let target = MuiMediaTransportMath.seekTime(ratio: ratio, duration: duration) else { return }
        player.seek(to: target)
        currentTime = target
    }
}

/// The placeholder player behind a `MuiVideoPlayer`/`MuiAudioPlayer` with
/// no `url` — the gallery's "feed nothing" demo state. Rather than being a
/// true no-op (which would leave the transport bar visually inert), each
/// command routes through an optional closure the owning view wires back
/// into its own `MuiMediaTransportModel` once that model exists — the same
/// two-phase wiring a real `AVPlayer` needs (the model has to exist before
/// anything can observe it), just without AVFoundation or the network
/// behind it.
final class MuiNullTransportPlayer: MuiTransportPlayerControlling {
    var onPlay: (() -> Void)?
    var onPause: (() -> Void)?
    var onSeek: ((Double) -> Void)?

    func play() { onPlay?() }
    func pause() { onPause?() }
    func seek(to seconds: Double) { onSeek?(seconds) }
}
