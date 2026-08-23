import XCTest
@testable import MapleUI

final class MuiPageEditorTests: XCTestCase {
    func testCropModeIsActiveOnlyForTheCropTool() {
        XCTAssertTrue(MuiPageEditor.cropModeActive(toolId: "crop"))
        XCTAssertFalse(MuiPageEditor.cropModeActive(toolId: "light"))
        XCTAssertFalse(MuiPageEditor.cropModeActive(toolId: nil))
    }

    func testArmedControlTabMapsLightAndColorToolsToTheirOwnTab() {
        XCTAssertEqual(MuiPageEditor.armedControlTab(toolId: "light"), "light")
        XCTAssertEqual(MuiPageEditor.armedControlTab(toolId: "color"), "color")
    }

    func testArmedControlTabCollapsesForTheCropTool() {
        XCTAssertNil(MuiPageEditor.armedControlTab(toolId: "crop"))
        XCTAssertNil(MuiPageEditor.armedControlTab(toolId: nil))
    }

    func testApplySliderChangeSetsTheGivenIdWithoutTouchingOthers() {
        let next = MuiPageEditor.applySliderChange(["exposure": 0.3, "contrast": 12], id: "exposure", value: 1.2)
        XCTAssertEqual(next["exposure"], 1.2)
        XCTAssertEqual(next["contrast"], 12)
    }

    func testApplySliderChangeAddsANewIdThatWasNotPresent() {
        let next = MuiPageEditor.applySliderChange([:], id: "vibrance", value: 40)
        XCTAssertEqual(next, ["vibrance": 40])
    }
}
