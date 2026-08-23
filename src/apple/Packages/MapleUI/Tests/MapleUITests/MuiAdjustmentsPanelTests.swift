import XCTest
@testable import MapleUI

final class MuiAdjustmentsPanelTests: XCTestCase {
    func testInitialOpenGroupIdsIncludesEveryGroupNotCollapsedByDefault() {
        let tabs = [
            MuiAdjustmentTab(id: "basic", label: "Basic", groups: [
                MuiAdjustmentGroup(id: "light", label: "Light", sliders: []),
                MuiAdjustmentGroup(id: "color", label: "Color", sliders: [], collapsedByDefault: true),
            ]),
        ]
        XCTAssertEqual(MuiAdjustmentsPanel.initialOpenGroupIds(tabs: tabs), ["light"])
    }

    func testInitialOpenGroupIdsSpansEveryTabNotJustTheFirst() {
        let tabs = [
            MuiAdjustmentTab(id: "basic", label: "Basic", groups: [MuiAdjustmentGroup(id: "light", label: "Light", sliders: [])]),
            MuiAdjustmentTab(id: "detail", label: "Detail", groups: [MuiAdjustmentGroup(id: "sharpen", label: "Sharpen", sliders: [])]),
        ]
        XCTAssertEqual(MuiAdjustmentsPanel.initialOpenGroupIds(tabs: tabs), ["light", "sharpen"])
    }

    func testInitialOpenGroupIdsIsEmptyWithNoTabs() {
        XCTAssertTrue(MuiAdjustmentsPanel.initialOpenGroupIds(tabs: []).isEmpty)
    }

    func testLightAndColorGroupFixturesCoverMaplesRealSliderNames() {
        XCTAssertEqual(
            MuiAdjustmentsPanel.lightGroup.sliders.map(\.label),
            ["Exposure", "Contrast", "Highlights", "Shadows", "Whites", "Blacks"]
        )
        XCTAssertEqual(
            MuiAdjustmentsPanel.colorGroup.sliders.map(\.label),
            ["Temp", "Tint", "Vibrance", "Saturation"]
        )
    }
}
