// MuiCameraSessionProviding.swift — the capture-session factory behind
// MuiQrScanner's camera path. Split out (same DI shape as
// MuiCameraAuthorizing) so a test can inject a fake that hands back a
// harmless, input-less `AVCaptureSession` (or `nil`, for the
// no-camera-available case) instead of MuiQrScanner ever touching the real
// `AVCaptureDevice` device-discovery APIs, which are hardware-dependent and
// unavailable in a CI sandbox or the Simulator.

import AVFoundation

protocol MuiCameraSessionProviding: Sendable {
    /// Builds a capture session wired to the default video device, or
    /// `nil` when no camera is available (Simulator, headless Mac, denied
    /// device access at the OS level below the permission check).
    func makeSession() -> AVCaptureSession?
}

struct MuiSystemCameraSessionProvider: MuiCameraSessionProviding {
    func makeSession() -> AVCaptureSession? {
        guard
            let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .unspecified),
            let input = try? AVCaptureDeviceInput(device: device)
        else {
            return nil
        }
        let session = AVCaptureSession()
        session.beginConfiguration()
        if session.canAddInput(input) {
            session.addInput(input)
        }
        session.commitConfiguration()
        return session
    }
}
