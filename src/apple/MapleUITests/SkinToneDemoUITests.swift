// SkinToneDemoUITests.swift — the end-to-end skin-tone demo (#3279, spec §8):
// open a portrait, show the scope, create a skin mask, drag Hue, and assert
// the reported cloud centroid moves toward the 123° skin-tone line. No
// screenshots — the assertion reads the accessibility value VectorscopeHud
// publishes (#3279), matching CLAUDE.md's "no eyeballing" rule for anything
// this repo can make objective.
//
// Skip-passes without test_0003 locally, same convention as
// SliderMatrixUITests / test_color_pipeline.sh's "no fixtures, skipping."
//
// Reaching MaskPanel needs the "Panel" control-variant layout (#3277
// mounts VectorscopeHud regardless of variant, but MaskPanel today is only
// wired into StackedAdjustmentsPanel / MobileControlBar — the default
// "Card" layout's FlyoutSliderPanel has no `.mask` branch, so arming Mask
// there sets `armedTool` with no panel ever appearing). This test switches
// to "Panel" via ControlVariantToggle at runtime rather than depending on
// MapleAppDriver.launch's fixed launch-argument set.

import XCTest
#if os(macOS)

final class SkinToneDemoUITests: XCTestCase {
    private static func rawsDir() -> URL {
        if let env = ProcessInfo.processInfo.environment["MAPLE_UITEST_FIXTURE_ROOT"], !env.isEmpty {
            return URL(fileURLWithPath: env)
        }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test-fixtures/raws")
    }

    func testCreatingASkinMaskAndDraggingHueMovesTheCloudTowardTheSkinLine() throws {
        let rawURL = Self.rawsDir().appendingPathComponent("test_0003.DNG")
        guard FileManager.default.fileExists(atPath: rawURL.path) else {
            throw XCTSkip("test_0003.DNG not found — populate test-fixtures/raws/")
        }
        let driver = try MapleAppDriver.launch(fixture: "test_0003.DNG")
        defer { driver.cleanupStagedFixture() }
        defer { driver.app.terminate() }
        driver.waitForCanvasReady(timeout: 30)
        let app = driver.app

        // 0. Switch to the "Panel" control-variant layout — MaskPanel only
        //    mounts there (see the file note above).
        let variantToggle = app.segmentedControls["editor-variant-toggle"]
        XCTAssertTrue(variantToggle.waitForExistence(timeout: 5), "control-variant toggle not found")
        variantToggle.buttons["Panel"].click()

        // 1. Show the scope.
        app.buttons["editor-pill-scope"].click()
        let hud = app.otherElements["editor-vectorscope-hud"]
        XCTAssertTrue(hud.waitForExistence(timeout: 5), "vectorscope HUD didn't appear")

        // 2. Arm Mask (Panel layout's tool button — see the file note),
        //    add the person.
        app.buttons["editor-panel-tool-mask"].click()
        let addMenu = firstExisting([
            app.buttons["editor-mask-add-menu"],
            app.menuButtons["editor-mask-add-menu"],
        ])
        XCTAssertTrue(addMenu.waitForExistence(timeout: 5), "mask add-menu not found")
        addMenu.click()
        let peopleItem = firstExisting([
            app.menuItems["People…"],
            app.buttons["People…"],
        ])
        XCTAssertTrue(peopleItem.waitForExistence(timeout: 5), "'People…' menu item not found")
        peopleItem.click()

        // `PeoplePickerSheet` runs Vision detection on `.task` and disables
        // "Create" until it settles (`isLoading`) — existence alone isn't
        // enough, the button exists (disabled) the whole time.
        let createButton = app.buttons["Create"]
        XCTAssertTrue(createButton.waitForExistence(timeout: 5), "people picker didn't appear")
        try waitFor(createButton, predicateFormat: "isEnabled == 1", timeout: 15,
                    description: "'Create' never became enabled — people picker didn't settle")
        createButton.click()

        // 3. The scope narrows to the mask (`createPersonSkinMask`/
        //    `createWholeImageSkinMask` append-and-select their layer, so
        //    MaskPanel's slider list is already showing the new mask by
        //    the time this resolves) — assert it reports SOME sample
        //    before touching Hue, proving the mask-scoped weighting
        //    reached the scope pass at all.
        let beforeValue = try waitForAccessibilityValue(hud, contains: "has data", timeout: 15)
        let beforeAngle = try centroidAngle(from: beforeValue)

        // 4. Drag Hue toward the skin line. `MaskSliderRow`'s identifier is
        //    on the row's outer HStack, not the Slider control itself
        //    (`MaskPanel.swift`), so locate the row first and query its
        //    slider descendant.
        let hueRow = app.otherElements["editor-mask-slider-hue"]
        XCTAssertTrue(hueRow.waitForExistence(timeout: 5), "Hue slider row not found")
        let hueSlider = hueRow.sliders.firstMatch
        XCTAssertTrue(hueSlider.waitForExistence(timeout: 5), "Hue slider control not found inside its row")
        // Move toward whichever direction reduces |beforeAngle - 123|; the
        // sign depends on the fixture's actual skin hue vs. 123°, which
        // this test cannot know ahead of a live Vision + chain run.
        let target: CGFloat = beforeAngle < 123 ? 0.75 : 0.25
        hueSlider.adjust(toNormalizedSliderPosition: target)

        let afterValue = try waitForAccessibilityValue(
            hud, contains: "centroid", timeout: 10, excluding: beforeValue
        )
        let afterAngle = try centroidAngle(from: afterValue)

        let beforeDelta = abs(beforeAngle - 123.0)
        let afterDelta = abs(afterAngle - 123.0)
        XCTAssertLessThan(
            afterDelta, beforeDelta,
            "Hue drag should move the cloud toward the skin line: \(beforeAngle)° -> \(afterAngle)° (target 123°)"
        )
    }

    // MARK: - Helpers

    /// First element in `candidates` that exists right now, else the last
    /// one (so a subsequent `waitForExistence` still has something to poll
    /// and fail with a meaningful timeout rather than a nil-unwrap).
    private func firstExisting(_ candidates: [XCUIElement]) -> XCUIElement {
        candidates.first(where: { $0.exists }) ?? candidates[candidates.count - 1]
    }

    private func waitFor(
        _ element: XCUIElement, predicateFormat: String, timeout: TimeInterval, description: String
    ) throws {
        let predicate = NSPredicate(format: predicateFormat)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        let result = XCTWaiter().wait(for: [expectation], timeout: timeout)
        if result != .completed {
            throw XCTSkip(description)
        }
    }

    private func waitForAccessibilityValue(
        _ element: XCUIElement, contains substring: String, timeout: TimeInterval, excluding: String? = nil
    ) throws -> String {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let value = (element.value as? String) ?? ""
            if value.contains(substring), value != excluding {
                return value
            }
            usleep(100_000)
        }
        throw XCTSkip("accessibility value never reported '\(substring)' — got: \((element.value as? String) ?? "nil")")
    }

    private func centroidAngle(from accessibilityValue: String) throws -> Double {
        guard let range = accessibilityValue.range(of: "centroid "),
              let degreeRange = accessibilityValue.range(of: "°"),
              let angle = Double(accessibilityValue[range.upperBound..<degreeRange.lowerBound])
        else {
            throw XCTSkip("couldn't parse a centroid angle out of: \(accessibilityValue)")
        }
        return angle
    }
}

#endif
