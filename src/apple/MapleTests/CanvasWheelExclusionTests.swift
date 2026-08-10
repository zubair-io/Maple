// CanvasWheelExclusionTests.swift — unit tests for the pure decision behind
// `reportsWheelExclusion(in:active:)` in `Maple/Views/CanvasZoomHost.swift`
// (#2683 round-2 review item 1).
//
// Lives in the MapleTests Xcode target (not MapleCore) because
// `CanvasWheelExclusion` is declared in the app target, per the
// `+VM.swift`-adjacent co-location pattern this target already uses for
// `BrowseGridVMTests` / `FullImageViewVMTests` / etc.
//
// Context: the Bug-A fix (commit 0831222d9) reported `FlyoutSliderPanel`'s
// whole frame as a wheel-exclusion region to `CanvasZoomHost`'s scroll-wheel
// catcher UNCONDITIONALLY — whenever the panel was mounted, regardless of
// which tool was armed. That silently broke the documented plain-wheel
// armed-tool nudge (`CanvasZoomHost`'s own header comment: "Plain wheel
// (macOS) → ... at fit it routes to onWheelEditing (armed-tool nudge in the
// editor)") for every tool OTHER than Film — a Light/Color/Effects/Detail
// slider armed while the panel was on screen could no longer be nudged by
// wheel, even though only Film's catalog list actually needs the exclusion.
//
// `EditorView` now passes `active: state.armedTool == .filmLook`, and
// `CanvasWheelExclusion.resolvedFrame` is the pure mapping from
// (panelFrame, active) to the value `CanvasZoomHost.handleWheel` actually
// gates on — these tests are the regression guard for that scoping,
// independent of a SwiftUI rendering harness.
//
// `handleWheel` itself stays private inside `CanvasZoomHost` (a SwiftUI
// View) and there's no XCUITest-independent way to drive real scroll
// events on this machine (#2525 blocks XCUITest automation mode) — this is
// the testable seam: `nil` here is EXACTLY what makes `handleWheel` skip
// its exclusion check and fall through to `controller.wheelIntent`
// unchanged, which is what restores the wheel-nudge for a non-Film tool.

import XCTest

@testable import Maple_Exposure

final class CanvasWheelExclusionTests: XCTestCase {
    private let panelFrame = CGRect(x: 12, y: 40, width: 300, height: 480)

    /// Film armed (`active: true`) — the exclusion applies, so
    /// `CanvasZoomHost.handleWheel` will route a wheel event over the panel
    /// to `FilmSection`'s own `ScrollView` instead of `wheelIntent`.
    func testActiveResolvesToThePanelFrame() {
        XCTAssertEqual(
            CanvasWheelExclusion.resolvedFrame(panelFrame: panelFrame, active: true),
            panelFrame
        )
    }

    /// The regression this item fixes: a NON-Film armed tool (`active:
    /// false`) must resolve to `nil` even though the panel genuinely has a
    /// real, non-empty frame on screen — `nil` is what lets
    /// `CanvasZoomHost.handleWheel` skip its exclusion check entirely and
    /// preserve the documented armed-tool wheel-nudge over the panel.
    func testInactiveResolvesToNilEvenWithARealPanelFramePresent() {
        XCTAssertNil(CanvasWheelExclusion.resolvedFrame(panelFrame: panelFrame, active: false))
    }

    /// Degenerate `.zero` frame (panel not yet laid out) behaves the same
    /// as any other frame — the gate is purely on `active`, not frame
    /// emptiness.
    func testActiveWithZeroFrameStillReportsIt() {
        XCTAssertEqual(
            CanvasWheelExclusion.resolvedFrame(panelFrame: .zero, active: true),
            .zero
        )
    }
}
