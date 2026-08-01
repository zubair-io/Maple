// CanvasCapture.swift — settle-then-screenshot machinery for the macOS
// canvas gates.
//
// Every macOS harness that reads pixels off the editor canvas needs the same
// two things, and both are subtle enough that a second copy would be a
// liability: (1) waiting until the `canvas-render-ready` sentinel has SETTLED
// rather than firing on its first appearance, and (2) grabbing the canvas
// without touching a vanished element.
//
// Extracted from `SliderMatrixUITests` (#2277) once the sidecar seam gate and
// the poisoned-cache upgrade gate (#1805) became the second and third callers.

import XCTest

#if os(macOS)
import AppKit

enum CanvasCapture {

    /// Overall budget for getting the canvas sentinel into a settled state.
    /// Generous, because settling may span several render cycles on a 100 MP
    /// fixture.
    static let settleDeadline: TimeInterval = 90

    /// The sentinel must exist continuously across this window to count as
    /// settled — long enough to outlast the gap between a fast-phase publish
    /// and the debounced refine that follows it (150 ms debounce, see
    /// `docs/architecture.md` § two-phase rendering).
    private static let settleWindow: TimeInterval = 1.0

    /// Poll interval inside the settle window.
    private static let settlePoll: TimeInterval = 0.1

    /// Final confirmation window immediately before the frame read, using an
    /// INVERTED expectation (wait for the sentinel to vanish; require that
    /// wait to time out). Shorter than `settleWindow` because it runs after
    /// settling already succeeded — its job is to shrink the gap between the
    /// last observation and the capture, not to re-prove the settle.
    private static let settleConfirmWindow: TimeInterval = 0.5

    /// Wait until `canvas` exists continuously for `settleWindow`, then return
    /// its frame. Returns nil if `settleDeadline` expires first.
    ///
    /// A bare `exists == 1` wait is not enough: the sentinel is published only
    /// between render cycles (`FullImageView+VM.canvasAccessibilityID(
    /// isRendering:hasPreview:)` publishes `canvas-render-ready` ONLY while
    /// `!isRendering && hasPreview`), so a single match can be a transient
    /// window that closes before the screenshot. Screenshotting the instant
    /// the predicate first matches therefore races a follow-on render, and
    /// `XCUIElement.screenshot()` on a vanished element raises an
    /// UNRECOVERABLE XCTest failure — which aborted an entire 606-case matrix
    /// instead of costing one case. Settling first also captures the quiesced
    /// render rather than an intermediate one, which is what a pixel diff
    /// wants anyway.
    ///
    /// Returning the FRAME (rather than a Bool the caller follows with its own
    /// `canvas.frame`) is deliberate: reading any `XCUIElement` attribute
    /// forces query resolution and raises the same unrecoverable failure as
    /// `.screenshot()` when the element has vanished. The only safe moment to
    /// read it is here, immediately after the settle window confirmed the
    /// element was up — so the caller never touches an unguarded attribute,
    /// and everything downstream works off this snapshot of the geometry.
    static func waitForSettledCanvas(_ canvas: XCUIElement) -> CGRect? {
        let deadline = Date().addingTimeInterval(settleDeadline)
        while Date() < deadline {
            let remaining = deadline.timeIntervalSinceNow
            guard remaining > 0 else { return nil }
            let expectation = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "exists == 1"), object: canvas)
            guard XCTWaiter().wait(for: [expectation], timeout: remaining) == .completed else {
                return nil
            }
            // Up — now confirm it STAYS up for the whole window. The explicit
            // poll runs at `settlePoll` (100 ms), so it samples the window
            // ~10x; `XCTNSPredicateExpectation` re-evaluates on a timer
            // (`XCUIElement.exists` is not KVO-observable), which would sample
            // it far more coarsely. The poll is therefore the sensitive
            // detector for the brief render-cycle flips.
            let checks = max(1, Int(settleWindow / settlePoll))
            let stayedUp = (0..<checks).allSatisfy { _ in
                Thread.sleep(forTimeInterval: settlePoll)
                return canvas.exists
            }
            guard stayedUp else { continue }  // flipped; wait for ready again

            // Then a final inverted confirmation adjacent to the frame read:
            // wait for the sentinel to VANISH and require that wait to TIME
            // OUT — a timeout is positive evidence it never disappeared across
            // `settleConfirmWindow`. This is the idiomatic XCTest form, and
            // unlike the poll it is continuous rather than sampled, so the two
            // are complementary.
            let vanished = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "exists == 0"), object: canvas)
            guard XCTWaiter().wait(for: [vanished], timeout: settleConfirmWindow) == .timedOut
            else { continue }  // it DID vanish; re-wait for ready

            // Read the frame while still inside the confirmed settled state.
            if canvas.exists { return canvas.frame }
            // Flipped back to `canvas-rendering`; loop and wait again.
        }
        return nil
    }

    /// PNG of the canvas at `frame`, preferring a tight element grab and
    /// falling back to a cropped full-screen capture.
    ///
    /// macOS XCUITest's element-relative screenshot falls back to a
    /// full-window capture for some SwiftUI views, hence the size heuristic:
    /// if the element snapshot is at most ~110% of the canvas frame in either
    /// axis it is a tight crop and is trusted; otherwise crop the screen.
    ///
    /// Exactly ONE `canvas.screenshot()` call on the tight path: each one is a
    /// fresh IPC round trip to the app, so calling it twice (once for
    /// `.image`, once for `.pngRepresentation`) would re-open the settle race.
    /// An `XCUIScreenshot` captures its pixels at creation, so both accessors
    /// describe the same instant. The fallback touches no element at all.
    static func canvasPNG(_ canvas: XCUIElement, frame: CGRect) -> Data? {
        let elementPNG: Data? = {
            guard canvas.exists else { return nil }
            let snap = canvas.screenshot()
            let size = snap.image.size
            let tight = size.width <= frame.width * 1.1 && size.height <= frame.height * 1.1
            return tight ? snap.pngRepresentation : nil
        }()
        return elementPNG ?? screenCropPNG(to: frame)
    }

    /// Full-screen grab cropped to `frame`, PNG-encoded. Needs no live
    /// element — this is the fallback whenever the sentinel can't be
    /// screenshot directly, so it must not touch the element at all.
    private static func screenCropPNG(to frame: CGRect) -> Data? {
        crop(XCUIScreen.main.screenshot().image, to: frame).tiffRepresentation
            .flatMap { NSBitmapImageRep(data: $0) }
            .flatMap { $0.representation(using: .png, properties: [:]) }
    }

    /// Crop an `NSImage` to `frame` in points.
    static func crop(_ image: NSImage, to frame: CGRect) -> NSImage {
        let target = NSSize(width: frame.width, height: frame.height)
        let cropped = NSImage(size: target)
        cropped.lockFocus()
        defer { cropped.unlockFocus() }
        image.draw(in: NSRect(origin: .zero, size: target),
                   from: NSRect(origin: frame.origin, size: target),
                   operation: .copy,
                   fraction: 1.0)
        return cropped
    }
}

#endif // os(macOS)
