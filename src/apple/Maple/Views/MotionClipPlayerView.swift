import AVKit
import SwiftUI

/// Plays a short clip that belongs to a still (an Android Motion Photo's
/// embedded video, or a Live Photo's paired clip) in place of that still,
/// once, starting on appear. An inline player (a grid tile) is muted and has
/// no transport controls.
/// The URL is resolved here rather than when the still opened, because it
/// carries a short-lived access token.
struct MotionClipPlayerView: View {
  let resolveURL: () async -> URL?
  var isInline = false
  let onFinished: () -> Void

  @State private var player: AVPlayer?

  var body: some View {
    Group {
      if let player {
        if isInline {
          InlineClipSurface(player: player)
        } else {
          #if os(macOS)
            MacVideoPlayerView(player: player)
          #else
            VideoPlayer(player: player)
          #endif
        }
      } else {
        ProgressView()
      }
    }
    .task { await play() }
    .onDisappear {
      player?.pause()
      player = nil
    }
    .accessibilityLabel(isInline ? "Live Photo clip" : "Motion Photo clip")
    .accessibilityIdentifier(isInline ? "grid-live-clip" : "preview-motion-clip")
  }

  @MainActor
  private func play() async {
    guard let url = await resolveURL() else {
      if !Task.isCancelled { onFinished() }
      return
    }
    guard !Task.isCancelled else { return }
    let item = AVPlayerItem(url: url)
    let next = AVPlayer(playerItem: item)
    next.isMuted = isInline
    player = next
    next.play()
    let ended = NotificationCenter.default.notifications(
      named: AVPlayerItem.didPlayToEndTimeNotification, object: item)
    let failedMidway = NotificationCenter.default.notifications(
      named: AVPlayerItem.failedToPlayToEndTimeNotification, object: item)
    let statuses = item.publisher(for: \.status).values
    await withTaskGroup(of: Void.self) { group in
      group.addTask { for await _ in ended { return } }
      group.addTask { for await _ in failedMidway { return } }
      group.addTask { for await status in statuses where status == .failed { return } }
      await group.next()
      group.cancelAll()
    }
    guard !Task.isCancelled else { return }
    onFinished()
  }
}

#if os(macOS)
  private struct InlineClipSurface: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> AVPlayerView {
      let view = AVPlayerView()
      view.controlsStyle = .none
      view.videoGravity = .resizeAspectFill
      view.player = player
      return view
    }

    func updateNSView(_ view: AVPlayerView, context: Context) {
      if view.player !== player { view.player = player }
    }
  }
#else
  private struct InlineClipSurface: UIViewControllerRepresentable {
    let player: AVPlayer

    func makeUIViewController(context: Context) -> AVPlayerViewController {
      let controller = AVPlayerViewController()
      controller.showsPlaybackControls = false
      controller.videoGravity = .resizeAspectFill
      controller.player = player
      return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
      if controller.player !== player { controller.player = player }
    }
  }
#endif
