import AVKit
import MapleCloudKit
import SwiftUI

/// Native full-screen playback for a video selected from the TV timeline.
struct TVVideoPlayerView: View {
  let asset: SearchAsset
  let videoClient: CloudVideoClient

  @State private var player: AVPlayer?
  @State private var unavailable = false

  var body: some View {
    Group {
      if let player {
        VideoPlayer(player: player)
      } else if unavailable {
        VStack(spacing: 18) {
          Image(systemName: "video.slash")
            .font(.system(size: 64))
          Text("Video unavailable")
            .font(.title2.bold())
        }
        .foregroundStyle(MapleTVTheme.textMuted)
      } else {
        ProgressView()
          .controlSize(.large)
      }
    }
    .task(id: asset.id) { await preparePlayer() }
    .onDisappear { releasePlayer() }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Video player")
    .accessibilityValue(asset.filename)
  }

  @MainActor
  private func preparePlayer() async {
    releasePlayer()
    unavailable = false
    let url = try? await videoClient.streamingURL(absPath: asset.abs_path)
    guard !Task.isCancelled else { return }
    guard let url else {
      unavailable = true
      return
    }
    let player = AVPlayer(url: url)
    self.player = player
    player.play()
  }

  @MainActor
  private func releasePlayer() {
    player?.pause()
    player = nil
  }
}
