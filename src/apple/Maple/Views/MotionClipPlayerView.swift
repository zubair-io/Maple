import AVKit
import SwiftUI

/// Plays a short clip that belongs to a still (an Android Motion Photo's
/// embedded video) in place of that still, once, starting on appear.
/// The URL is resolved here rather than when the still opened, because it
/// carries a short-lived access token.
struct MotionClipPlayerView: View {
  let resolveURL: () async -> URL?
  let onFinished: () -> Void

  @State private var player: AVPlayer?

  var body: some View {
    Group {
      if let player {
        #if os(macOS)
          MacVideoPlayerView(player: player)
        #else
          VideoPlayer(player: player)
        #endif
      } else {
        ProgressView()
      }
    }
    .task { await play() }
    .onDisappear {
      player?.pause()
      player = nil
    }
    .accessibilityLabel("Motion Photo clip")
    .accessibilityIdentifier("preview-motion-clip")
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
