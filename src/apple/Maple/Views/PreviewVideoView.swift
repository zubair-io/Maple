import AVKit
import MapleCore
import MapleUI
import SwiftUI

struct PreviewVideoView: View {
  let asset: AssetRef
  let source: (any ImageSource)?

  @State private var player: AVPlayer?
  @State private var unavailable = false

  var body: some View {
    Group {
      if let player {
        #if os(macOS)
          MacVideoPlayerView(player: player)
        #else
          VideoPlayer(player: player)
        #endif
      } else if unavailable {
        VStack(spacing: 12) {
          MuiIcon(name: "videocam_off", size: .xl)
            .font(.system(size: 40))
          Text("Video unavailable")
            .font(.headline)
        }
        .foregroundStyle(ProTokens.textDim)
      } else {
        ProgressView()
      }
    }
    .task(id: asset.id) { await preparePlayer() }
    .onDisappear {
      player?.pause()
      player = nil
    }
    .accessibilityLabel("Video player")
    .accessibilityIdentifier("preview-video")
  }

  @MainActor
  private func preparePlayer() async {
    player?.pause()
    player = nil
    unavailable = false
    let url: URL?
    if let localURL = asset.primaryURL {
      url = localURL
    } else if let cloud = source as? CloudSource, let stableID = asset.stableID {
      url = try? await cloud.videoURL(for: stableID)
    } else {
      url = nil
    }
    guard !Task.isCancelled else { return }
    guard let url else {
      unavailable = true
      return
    }
    player = AVPlayer(url: url)
  }
}

#if os(macOS)
  /// Avoid SwiftUI's `_AVKit_SwiftUI` video view on macOS. On the v0.1.5 QA
  /// runtime, creating that view aborts while initializing its class metadata.
  private struct MacVideoPlayerView: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> AVPlayerView {
      let view = AVPlayerView()
      view.controlsStyle = .inline
      view.player = player
      return view
    }

    func updateNSView(_ view: AVPlayerView, context: Context) {
      if view.player !== player {
        view.player = player
      }
    }
  }
#endif
