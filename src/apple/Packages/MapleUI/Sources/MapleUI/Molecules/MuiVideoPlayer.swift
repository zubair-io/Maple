// MuiVideoPlayer.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.7; Built from: Button, Progress, Timestamp). Transport controls
// (play/pause, click-to-seek scrubber, mm:ss readouts) around a real
// `AVPlayer`, driven through the thin `MuiMediaTransportModel` — see that
// type's doc comment for why the model never touches AVFoundation itself.
//
// With no `url` (the gallery's "feed nothing" demo state — no real
// playback, no network), the transport bar still works against a
// preset-but-static demo model wired through `MuiNullTransportPlayer`, so
// play/pause and the scrubber remain interactive to try even without a
// real clip.

import SwiftUI
import AVFoundation

public struct MuiVideoPlayer: View {
    public let url: URL?
    public let accessibilityLabel: String

    @State private var avController: MuiAVPlayerTransportController?
    @StateObject private var demoModel: MuiMediaTransportModel

    public init(url: URL?, accessibilityLabel: String = "Video player") {
        self.url = url
        self.accessibilityLabel = accessibilityLabel
        let demoPlayer = MuiNullTransportPlayer()
        let model = MuiMediaTransportModel(player: demoPlayer, currentTime: 42, duration: 125)
        demoPlayer.onPlay = { [weak model] in model?.setPlaying(true) }
        demoPlayer.onPause = { [weak model] in model?.setPlaying(false) }
        demoPlayer.onSeek = { [weak model] time in model?.handleTimeUpdate(currentTime: time) }
        self._demoModel = StateObject(wrappedValue: model)
    }

    private var model: MuiMediaTransportModel { avController?.model ?? demoModel }

    public var body: some View {
        VStack(spacing: MuiTokens.spacingSm) {
            ZStack {
                MuiTokens.imageCanvas
                if let avController {
                    MuiVideoSurface(player: avController.player)
                } else {
                    MuiIcon(name: "play.rectangle", size: .xl, color: MuiTokens.textMuted)
                }
            }
            .aspectRatio(16.0 / 9.0, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous)
                    .stroke(MuiTokens.border, lineWidth: 1)
            )

            MuiMediaTransportBar(model: model)
        }
        .onAppear {
            guard let url, avController == nil else { return }
            avController = MuiAVPlayerTransportController(url: url)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
    }
}

#Preview("MuiVideoPlayer") {
    MuiVideoPlayer(url: nil)
        .frame(width: 320)
        .padding()
        .background(MuiTokens.bg)
}
