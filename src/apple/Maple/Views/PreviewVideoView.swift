import AVKit
import MapleCore
import SwiftUI

struct PreviewVideoView: View {
    let asset: AssetRef
    let source: (any ImageSource)?

    @State private var player: AVPlayer?
    @State private var unavailable = false

    var body: some View {
        Group {
            if let player {
                VideoPlayer(player: player)
            } else if unavailable {
                VStack(spacing: 12) {
                    Image(systemName: "video.slash")
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
