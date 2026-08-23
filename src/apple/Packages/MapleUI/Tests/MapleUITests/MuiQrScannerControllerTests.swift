import XCTest
import AVFoundation
@testable import MapleUI

private struct FakeAuthorizer: MuiCameraAuthorizing {
    let granted: Bool
    func requestAccess() async -> Bool { granted }
}

private struct FakeSessionProvider: MuiCameraSessionProviding {
    /// `nil` reproduces the "no camera available" branch (Simulator,
    /// headless Mac); a real-but-input-less `AVCaptureSession` reproduces
    /// a successful session build without ever touching actual camera
    /// hardware or a device permission prompt in CI.
    let session: AVCaptureSession?
    func makeSession() -> AVCaptureSession? { session }
}

@MainActor
final class MuiQrScannerControllerTests: XCTestCase {
    func testDeniedAuthorizationSurfacesAFallbackErrorAndNeverBuildsASession() async {
        let sessionProvider = FakeSessionProvider(session: AVCaptureSession())
        let controller = MuiQrScannerController(authorizer: FakeAuthorizer(granted: false), sessionProvider: sessionProvider)

        await controller.startCamera()

        XCTAssertFalse(controller.cameraActive)
        XCTAssertNil(controller.session)
        XCTAssertEqual(controller.cameraError, "Camera access was denied — paste the code instead.")
    }

    func testGrantedButNoAvailableCameraSurfacesAnUnavailableFallbackError() async {
        let controller = MuiQrScannerController(authorizer: FakeAuthorizer(granted: true), sessionProvider: FakeSessionProvider(session: nil))

        await controller.startCamera()

        XCTAssertFalse(controller.cameraActive)
        XCTAssertNil(controller.session)
        XCTAssertEqual(controller.cameraError, "Camera not available on this device — paste the code instead.")
    }

    func testGrantedWithASessionActivatesTheCameraAndClearsAnyPriorError() async {
        let fakeSession = AVCaptureSession()
        let controller = MuiQrScannerController(authorizer: FakeAuthorizer(granted: true), sessionProvider: FakeSessionProvider(session: fakeSession))

        await controller.startCamera()

        XCTAssertTrue(controller.cameraActive)
        XCTAssertNotNil(controller.session)
        XCTAssertNil(controller.cameraError)

        controller.stopCamera()

        XCTAssertFalse(controller.cameraActive)
        XCTAssertNil(controller.session)
    }

    func testPasteResultTrimsAndEmitsTheCode() {
        XCTAssertEqual(MuiQrScanner.pasteResult(draft: "  ABC-123  "), "ABC-123")
    }

    func testPasteResultIgnoresAnEmptyOrWhitespaceOnlySubmission() {
        XCTAssertNil(MuiQrScanner.pasteResult(draft: "   "))
        XCTAssertNil(MuiQrScanner.pasteResult(draft: ""))
    }
}
