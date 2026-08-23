// MuiQrScanner.swift — Maple UI Molecules-L2 (unified-component-catalog.md
// §3). Camera or paste payload capture, built from Input, Button, Canvas
// Surface.
//
// The paste path is the fully-supported path: a text field plus a "Use
// code" button that emits `scanned` with the trimmed payload — no camera
// or decode dependency required. The camera path is a real
// `AVCaptureDevice` permission request (not a stub), via the injectable
// `MuiCameraAuthorizing`/`MuiCameraSessionProviding` seams (mirrors
// MuiPasteboard's protocol-behind-a-real-implementation split): on
// success it streams the live feed onto the canvas-surface viewfinder; on
// failure (denied permission, or no camera device — Simulator, headless
// Mac) it surfaces `cameraError` and the paste form stays available as the
// fallback, since it's never hidden by camera state. Decoding a QR payload
// out of the live frames would need a dedicated decoder this package
// doesn't have (same "no existing QR decoder" gap noted on the web
// reference) — wiring that in is future work, not something this molecule
// can respond to today.

import SwiftUI
@preconcurrency import AVFoundation

/// Drives the camera permission + session lifecycle — factored out of the
/// view so it's unit-testable against injected authorizer/session-provider
/// fakes instead of the real system camera.
@MainActor
final class MuiQrScannerController: ObservableObject {
    @Published private(set) var cameraActive = false
    @Published private(set) var cameraError: String?
    @Published private(set) var session: AVCaptureSession?

    private let authorizer: MuiCameraAuthorizing
    private let sessionProvider: MuiCameraSessionProviding

    init(
        authorizer: MuiCameraAuthorizing = MuiSystemCameraAuthorizer(),
        sessionProvider: MuiCameraSessionProviding = MuiSystemCameraSessionProvider()
    ) {
        self.authorizer = authorizer
        self.sessionProvider = sessionProvider
    }

    func startCamera() async {
        cameraError = nil
        guard await authorizer.requestAccess() else {
            cameraError = "Camera access was denied — paste the code instead."
            cameraActive = false
            return
        }
        guard let newSession = sessionProvider.makeSession() else {
            cameraError = "Camera not available on this device — paste the code instead."
            cameraActive = false
            return
        }
        session = newSession
        cameraActive = true
        DispatchQueue.global(qos: .userInitiated).async {
            newSession.startRunning()
        }
    }

    func stopCamera() {
        session?.stopRunning()
        session = nil
        cameraActive = false
    }
}

public struct MuiQrScanner: View {
    public let scanned: ((String) -> Void)?

    @State private var pasteValue = ""
    @StateObject private var controller: MuiQrScannerController

    public init(scanned: ((String) -> Void)? = nil) {
        self.scanned = scanned
        self._controller = StateObject(wrappedValue: MuiQrScannerController())
    }

    init(scanned: ((String) -> Void)?, controller: @autoclosure @escaping () -> MuiQrScannerController) {
        self.scanned = scanned
        self._controller = StateObject(wrappedValue: controller())
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            if controller.cameraActive, let session = controller.session {
                MuiCanvasSurface(contentAspect: 4.0 / 3.0) { _ in
                    MuiCameraPreviewSurface(session: session)
                }
                .frame(height: 200)
                MuiButton(label: "Stop camera", variant: .ghost, size: .sm) {
                    controller.stopCamera()
                }
            } else {
                MuiButton(label: "Use camera", variant: .secondary, leadingIcon: "camera") {
                    Task { await controller.startCamera() }
                }
                if let cameraError = controller.cameraError {
                    MuiText(cameraError, variant: .body, color: .error, block: true)
                }
            }

            HStack(spacing: MuiTokens.spacingSm) {
                MuiInput(
                    value: $pasteValue,
                    accessibilityLabel: "Pairing code",
                    placeholder: "Paste pairing code",
                    onCommit: submitPaste
                )
                MuiButton(label: "Use code", variant: .primary) { submitPaste() }
            }
        }
        .onDisappear { controller.stopCamera() }
    }

    private func submitPaste() {
        guard let next = Self.pasteResult(draft: pasteValue) else { return }
        scanned?(next)
        pasteValue = ""
    }

    /// The payload to emit for a paste submission — `nil` when the trimmed
    /// draft is empty, so an empty/whitespace-only paste is a no-op.
    /// Public + static so this is unit-testable without rendering a view.
    public static func pasteResult(draft: String) -> String? {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

#Preview("MuiQrScanner") {
    MuiQrScanner()
        .padding()
        .frame(width: 320)
        .background(MuiTokens.bg)
}
