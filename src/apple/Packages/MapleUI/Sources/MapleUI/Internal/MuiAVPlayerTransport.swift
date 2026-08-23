// MuiAVPlayerTransport.swift — the real AVFoundation wiring behind
// MuiVideoPlayer/MuiAudioPlayer when given a `url` (unified-component-
// catalog.md §2.7). AVPlayer has no declarative event-binding API the way
// a web `<video>`/`<audio>` element does (`onloadedmetadata`,
// `ontimeupdate`, `onplay`, `onpause`, `onended`), so this controller
// attaches the KVO/notification/periodic-observer equivalents itself and
// feeds every one into a `MuiMediaTransportModel` — the one piece of this
// wave that can't be unit-tested without a real player, so it stays a thin
// adapter with (almost) no logic of its own; the actual state transitions
// it drives all live in the already-tested `MuiMediaTransportModel`.

import Foundation
import AVFoundation
import Combine

/// Drives a real `AVPlayer` from a `MuiMediaTransportModel`'s commands.
final class MuiAVPlayerTransportAdapter: MuiTransportPlayerControlling {
    private let player: AVPlayer

    init(player: AVPlayer) {
        self.player = player
    }

    func play() { player.play() }
    func pause() { player.pause() }

    func seek(to seconds: Double) {
        player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600))
    }
}

@MainActor
final class MuiAVPlayerTransportController: ObservableObject {
    let player: AVPlayer
    let model: MuiMediaTransportModel

    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var durationTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()

    init(url: URL) {
        let player = AVPlayer(url: url)
        self.player = player
        self.model = MuiMediaTransportModel(player: MuiAVPlayerTransportAdapter(player: player))
        attachObservers()
    }

    private func attachObservers() {
        // Both callbacks below already run on the main queue (`queue: .main`),
        // but that's a runtime guarantee the compiler can't see through a
        // plain closure type — hopping into an explicit `@MainActor` `Task`
        // is what actually satisfies Swift concurrency's static isolation
        // check for calling into the (`@MainActor`) model.
        let interval = CMTime(seconds: 0.25, preferredTimescale: 600)
        timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            Task { @MainActor in self?.model.handleTimeUpdate(currentTime: time.seconds) }
        }

        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: player.currentItem,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.model.handleEnded() }
        }

        player.publisher(for: \.timeControlStatus)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                self?.model.setPlaying(status == .playing)
            }
            .store(in: &cancellables)

        durationTask = Task { [weak self] in
            guard let self, let item = self.player.currentItem else { return }
            if let duration = try? await item.asset.load(.duration), duration.isNumeric {
                self.model.handleLoadedMetadata(duration: duration.seconds)
            }
        }
    }

    deinit {
        if let timeObserver {
            player.removeTimeObserver(timeObserver)
        }
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
        durationTask?.cancel()
    }
}
