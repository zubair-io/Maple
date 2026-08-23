// MuiCameraPreviewSurface.swift — the raw AVCaptureVideoPreviewLayer
// surface behind MuiQrScanner's live viewfinder. Same shape as
// MuiVideoSurface's AVPlayerLayer wrapper: a layer-backed
// UIView/NSView, no chrome of its own — MuiQrScanner supplies the
// permission flow and paste fallback around it.

import SwiftUI
import AVFoundation

#if canImport(UIKit)
import UIKit

final class MuiCameraLayerView: UIView {
    override static var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

struct MuiCameraPreviewSurface: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> MuiCameraLayerView {
        let view = MuiCameraLayerView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ uiView: MuiCameraLayerView, context: Context) {
        uiView.previewLayer.session = session
    }
}
#elseif canImport(AppKit)
import AppKit

final class MuiCameraLayerView: NSView {
    let previewLayer = AVCaptureVideoPreviewLayer()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer = previewLayer
        previewLayer.videoGravity = .resizeAspectFill
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

struct MuiCameraPreviewSurface: NSViewRepresentable {
    let session: AVCaptureSession

    func makeNSView(context: Context) -> MuiCameraLayerView {
        let view = MuiCameraLayerView()
        view.previewLayer.session = session
        return view
    }

    func updateNSView(_ nsView: MuiCameraLayerView, context: Context) {
        nsView.previewLayer.session = session
    }
}
#endif
