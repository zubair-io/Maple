// MuiVideoSurface.swift — the raw AVPlayerLayer surface behind
// MuiVideoPlayer (unified-component-catalog.md §2.7), with no native
// playback chrome of its own (unlike AVKit's `VideoPlayer`, which always
// draws system transport controls) — MuiVideoPlayer supplies its own
// tokenized transport bar around this, mirroring the web reference's plain
// `<video>` element with custom controls layered on top.

import SwiftUI
import AVFoundation

#if canImport(UIKit)
import UIKit

final class MuiPlayerLayerView: UIView {
    override static var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

struct MuiVideoSurface: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> MuiPlayerLayerView {
        let view = MuiPlayerLayerView()
        view.playerLayer.player = player
        view.playerLayer.videoGravity = .resizeAspect
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ uiView: MuiPlayerLayerView, context: Context) {
        uiView.playerLayer.player = player
    }
}
#elseif canImport(AppKit)
import AppKit

final class MuiPlayerLayerView: NSView {
    let playerLayer = AVPlayerLayer()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer = playerLayer
        playerLayer.videoGravity = .resizeAspect
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

struct MuiVideoSurface: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> MuiPlayerLayerView {
        let view = MuiPlayerLayerView()
        view.playerLayer.player = player
        return view
    }

    func updateNSView(_ nsView: MuiPlayerLayerView, context: Context) {
        nsView.playerLayer.player = player
    }
}
#endif
