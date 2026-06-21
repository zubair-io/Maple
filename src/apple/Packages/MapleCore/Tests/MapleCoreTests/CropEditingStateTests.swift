// CropEditingStateTests.swift — crop-editing wiring on EditorState /
// EditSession (#638). Verifies the armed/disarmed gate that mirrors the web
// `CropSessionService.active`: arming `.crop` shows the full frame
// (effectiveCrop == identity, effectiveImageSize == native) and disarming
// applies the crop (effectiveCrop == model.crop, effectiveImageSize ==
// cropped). MainActor — EditSession + EditorState are both MainActor.

import XCTest
import CoreGraphics
@testable import MapleCore

@MainActor
final class CropEditingStateTests: XCTestCase {
    private func makeState() -> EditorState {
        EditorState(session: EditSession.preview())
    }

    func testArmCropEntersCropEditing() {
        let state = makeState()
        XCTAssertFalse(state.session.cropEditingActive)
        state.arm(tool: .crop)
        XCTAssertTrue(state.session.cropEditingActive)
        XCTAssertEqual(state.armedTool, .crop)
    }

    func testArmOtherToolLeavesCropEditing() {
        let state = makeState()
        state.arm(tool: .crop)
        XCTAssertTrue(state.session.cropEditingActive)
        state.arm(tool: .exposure)
        XCTAssertFalse(state.session.cropEditingActive)
    }

    func testEnteringCropResetsAspectToFree() {
        let state = makeState()
        state.setCropAspect(.sixteenNine)
        state.arm(tool: .crop)
        XCTAssertEqual(state.cropAspectId, .free)
    }

    func testEffectiveCropIsIdentityWhileEditing() {
        let state = makeState()
        state.session.model.crop = Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 0)
        state.arm(tool: .crop)
        // While the crop tool is armed the render path shows the full frame.
        XCTAssertEqual(state.session.effectiveCrop, .identity)
    }

    func testEffectiveCropIsModelCropWhenDisarmed() {
        let state = makeState()
        let crop = Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 0)
        state.session.model.crop = crop
        state.arm(tool: .exposure)
        XCTAssertEqual(state.session.effectiveCrop, crop)
    }

    func testEffectiveImageSizeFullFrameWhileEditing() {
        let state = makeState()
        state.session.nativeImageSize = CGSize(width: 4000, height: 3000)
        state.session.model.crop = Crop(top: 0.25, left: 0.25, bottom: 0.75, right: 0.75, angle: 0)
        state.arm(tool: .crop)
        XCTAssertEqual(state.session.effectiveImageSize, CGSize(width: 4000, height: 3000))
    }

    func testEffectiveImageSizeCroppedWhenDisarmed() {
        let state = makeState()
        state.session.nativeImageSize = CGSize(width: 4000, height: 3000)
        state.session.model.crop = Crop(top: 0.25, left: 0.25, bottom: 0.75, right: 0.75, angle: 0)
        state.arm(tool: .exposure)
        XCTAssertEqual(state.session.effectiveImageSize, CGSize(width: 2000, height: 1500))
    }

    func testEffectiveImageSizeZeroBeforeMetadataSeed() {
        let state = makeState()
        // nativeImageSize is .zero until the seed lands — must stay .zero.
        state.session.model.crop = Crop(top: 0.25, left: 0.25, bottom: 0.75, right: 0.75, angle: 0)
        XCTAssertEqual(state.session.effectiveImageSize, .zero)
    }
}
