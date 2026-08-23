// MuiAudioPlayer.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.7; Built from: Button, Progress, Timestamp). "Waveform-less audio
// transport" per the catalog — the same play/pause + scrubber + mm:ss
// shape as MuiVideoPlayer, driven by the same `MuiMediaTransportModel`,
// just with no video surface (no poster/frame — see MuiVideoPlayer's doc
// comment for the shared transport model + demo-state rationale).

import SwiftUI
import AVFoundation

public struct MuiAudioPlayer: View {
    public let url: URL?
    public let title: String?
    public let accessibilityLabel: String

    @State private var avController: MuiAVPlayerTransportController?
    @StateObject private var demoModel: MuiMediaTransportModel

    public init(url: URL?, title: String? = nil, accessibilityLabel: String = "Audio player") {
        self.url = url
        self.title = title
        self.accessibilityLabel = accessibilityLabel
        let demoPlayer = MuiNullTransportPlayer()
        let model = MuiMediaTransportModel(player: demoPlayer, currentTime: 18, duration: 64)
        demoPlayer.onPlay = { [weak model] in model?.setPlaying(true) }
        demoPlayer.onPause = { [weak model] in model?.setPlaying(false) }
        demoPlayer.onSeek = { [weak model] time in model?.handleTimeUpdate(currentTime: time) }
        self._demoModel = StateObject(wrappedValue: model)
    }

    private var model: MuiMediaTransportModel { avController?.model ?? demoModel }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
            if let title {
                MuiText(title, variant: .rowLabel, truncate: true)
            }
            MuiMediaTransportBar(model: model)
        }
        .padding(MuiTokens.spacingSm)
        .background(MuiTokens.surfaceAlt, in: RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous))
        .onAppear {
            guard let url, avController == nil else { return }
            avController = MuiAVPlayerTransportController(url: url)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
    }
}

#Preview("MuiAudioPlayer") {
    MuiAudioPlayer(url: nil, title: "Voice memo — Studio session")
        .frame(width: 320)
        .padding()
        .background(MuiTokens.bg)
}
