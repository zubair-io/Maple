// MuiCameraAuthorizing.swift — the camera-permission shim MuiQrScanner asks
// before starting a capture session. Same idea as MuiPasteboard's
// protocol-behind-a-real-implementation split: `MuiSystemCameraAuthorizer`
// makes a genuine `AVCaptureDevice.requestAccess` call, and the protocol
// lets tests inject a fake that resolves granted/denied instantly instead
// of racing (or ever showing) the real system permission prompt.

import AVFoundation

protocol MuiCameraAuthorizing: Sendable {
    /// Resolves to `true` once the caller may start a capture session —
    /// either because access was already granted, or because the user just
    /// granted it in response to this call's own system prompt. Resolves
    /// to `false` on a denied/restricted status, without ever presenting a
    /// prompt for those states (matching `AVCaptureDevice`'s own contract:
    /// `requestAccess` only prompts from `.notDetermined`).
    func requestAccess() async -> Bool
}

struct MuiSystemCameraAuthorizer: MuiCameraAuthorizing {
    func requestAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            return true
        case .denied, .restricted:
            return false
        case .notDetermined:
            return await AVCaptureDevice.requestAccess(for: .video)
        @unknown default:
            return false
        }
    }
}
