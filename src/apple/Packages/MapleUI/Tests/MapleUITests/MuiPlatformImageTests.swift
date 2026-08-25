import XCTest
import SwiftUI
@testable import MapleUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

final class MuiPlatformImageTests: XCTestCase {
    private var tempURL: URL?

    override func tearDownWithError() throws {
        if let tempURL {
            try? FileManager.default.removeItem(at: tempURL)
        }
        tempURL = nil
        try super.tearDownWithError()
    }

    func testLoadDecodesValidImageWhenNotCancelled() async throws {
        let url = try writeTempPNG()
        let image = await MuiPlatformImage.load(from: url)
        XCTAssertNotNil(image)
    }

    func testLoadReturnsNilForUnreadableURL() async {
        let url = URL(fileURLWithPath: "/tmp/mui-platform-image-does-not-exist-\(UUID().uuidString).png")
        let image = await MuiPlatformImage.load(from: url)
        XCTAssertNil(image)
    }

    /// Regression test for the `Task.detached` structured-concurrency bug:
    /// `load` used to spawn an unstructured detached task, so cancelling
    /// the caller (the way `.task(id:)` cancels its previous run on a
    /// rapid URL change) never reached the in-flight decode. `load` is
    /// now a plain nonisolated async function — a suspension point of the
    /// *same* task — so a parent task cancelled before the call must see
    /// that cancellation and return early (`nil`) instead of decoding.
    func testLoadReturnsNilWhenParentTaskIsCancelledBeforeStart() async throws {
        let url = try writeTempPNG()
        let task = Task<Image?, Never> {
            await MuiPlatformImage.load(from: url)
        }
        task.cancel()
        let result = await task.value
        XCTAssertNil(result)
    }

    // MARK: - Helpers

    private func writeTempPNG() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("mui-platform-image-\(UUID().uuidString).png")
        try makeTestPNGData().write(to: url)
        tempURL = url
        return url
    }

    private func makeTestPNGData() throws -> Data {
        let size = CGSize(width: 4, height: 4)
        #if canImport(UIKit)
        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { _ in
            UIColor.red.setFill()
            UIRectFill(CGRect(origin: .zero, size: size))
        }
        guard let data = image.pngData() else {
            throw XCTSkip("Could not render a test PNG on this platform")
        }
        return data
        #elseif canImport(AppKit)
        let image = NSImage(size: size)
        image.lockFocus()
        NSColor.red.setFill()
        NSRect(origin: .zero, size: size).fill()
        image.unlockFocus()
        guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
              let data = bitmap.representation(using: .png, properties: [:]) else {
            throw XCTSkip("Could not render a test PNG on this platform")
        }
        return data
        #else
        throw XCTSkip("No platform image renderer available")
        #endif
    }
}
