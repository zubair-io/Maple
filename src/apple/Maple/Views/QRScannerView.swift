// QRScannerView.swift — camera-backed QR scanner for the pairing flow
// (iOS only). Wraps `AVCaptureSession` + `AVCaptureMetadataOutput` inside a
// `UIViewControllerRepresentable`.
//
// The server's admin page renders a JSON envelope as a QR code:
//
//   { "url": "https://maple-server.local:3000", "token": "..." }
//
// On first scan we hand the raw payload to the parent sheet, which decodes
// + pre-fills the form; the user still hits Connect to commit.
//
// Camera permission is declared via the `INFOPLIST_KEY_NSCameraUsageDescription`
// Xcode build setting on the Maple target (GENERATE_INFOPLIST_FILE = YES).

import Foundation

// MARK: - PairingEnvelope

/// Wire format of the QR pairing payload.
struct PairingEnvelope: Decodable {
    let url: String
    let token: String?
}

#if os(iOS)

import SwiftUI
import AVFoundation
import AudioToolbox
import UIKit

// MARK: - QRScannerView

struct QRScannerView: View {
    let onScanned: (String) -> Void
    let onCancel: () -> Void

    @State private var cameraError: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if let cameraError {
                    VStack(spacing: 12) {
                        Image(systemName: "camera.slash")
                            .font(.system(size: 48))
                            .foregroundStyle(.white)
                        Text(cameraError)
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                    }
                } else {
                    QRScannerRepresentable(onScanned: onScanned,
                                           onError: { cameraError = $0 })
                        .ignoresSafeArea()
                    VStack {
                        Spacer()
                        Text("Point at the pairing QR code")
                            .foregroundStyle(.white)
                            .padding(12)
                            .background(.black.opacity(0.6),
                                        in: RoundedRectangle(cornerRadius: 10))
                            .padding(.bottom, 32)
                    }
                }
            }
            .navigationTitle("Scan QR Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
            }
        }
    }
}

// MARK: - QRScannerRepresentable

/// Bridges an AVFoundation-backed scanner view controller into SwiftUI.
private struct QRScannerRepresentable: UIViewControllerRepresentable {
    let onScanned: (String) -> Void
    let onError: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerViewController {
        let vc = QRScannerViewController()
        vc.onScanned = { payload in
            onScanned(payload)
        }
        vc.onError = { message in
            onError(message)
        }
        return vc
    }

    func updateUIViewController(_ uiViewController: QRScannerViewController,
                                context: Context) {
        // No-op — the controller drives itself.
    }
}

// MARK: - QRScannerViewController

/// Thin `AVCaptureSession` host. Runs the session on the main thread for
/// simplicity; the capture pipeline is low-volume (metadata objects only).
final class QRScannerViewController: UIViewController,
                                     AVCaptureMetadataOutputObjectsDelegate {

    var onScanned: ((String) -> Void)?
    var onError: ((String) -> Void)?

    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?

    /// Latch so we don't fire `onScanned` twice for the same payload.
    private var hasDelivered = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureSession()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if !session.isRunning {
            // Starting the session can block briefly on first launch — push
            // to a background queue to avoid jank.
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.session.startRunning()
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning { session.stopRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    // MARK: - Setup

    private func configureSession() {
        guard let device = AVCaptureDevice.default(for: .video) else {
            onError?("No camera available on this device.")
            return
        }
        do {
            let input = try AVCaptureDeviceInput(device: device)
            if session.canAddInput(input) { session.addInput(input) }
        } catch {
            onError?("Camera unavailable: \(error.localizedDescription)")
            return
        }

        let output = AVCaptureMetadataOutput()
        if session.canAddOutput(output) {
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            // Attach types only after the output is on the session, otherwise
            // AVFoundation throws on availableMetadataObjectTypes queries.
            output.metadataObjectTypes = [.qr]
        } else {
            onError?("Cannot attach metadata output to capture session.")
            return
        }

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        self.previewLayer = preview
    }

    // MARK: - AVCaptureMetadataOutputObjectsDelegate

    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard !hasDelivered else { return }
        for obj in metadataObjects {
            guard let code = obj as? AVMetadataMachineReadableCodeObject,
                  code.type == .qr,
                  let payload = code.stringValue else { continue }
            hasDelivered = true
            AudioServicesPlaySystemSound(1057) // Tink
            onScanned?(payload)
            return
        }
    }
}

#else

// MARK: - macOS fallback
//
// QR scanning via the built-in webcam is an unusual workflow on macOS; the
// button is hidden via `#if os(iOS)` in the sheet. This stub keeps the type
// nominally visible so cross-platform callers compile without branching on
// every reference site.

import SwiftUI

struct QRScannerView: View {
    let onScanned: (String) -> Void
    let onCancel: () -> Void

    var body: some View {
        Text("QR scanning is iOS-only.")
            .padding()
    }
}

#endif
