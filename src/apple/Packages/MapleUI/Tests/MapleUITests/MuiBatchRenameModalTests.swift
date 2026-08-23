import XCTest
@testable import MapleUI

final class MuiBatchRenameModalTests: XCTestCase {
    func testApplyTemplateSubstitutesDateSeqAndCamera() {
        let item = MuiBatchRenameSourceItem(id: "1", filename: "IMG_0042.dng", date: "2026-08-01", camera: "SonyA7IV")
        let result = MuiBatchRenameModal.applyTemplate("{date}_{seq}_{camera}", item: item, seq: 7)
        XCTAssertEqual(result, "2026-08-01_007_SonyA7IV")
    }

    func testApplyTemplatePadsSequenceToThreeDigits() {
        let item = MuiBatchRenameSourceItem(id: "1", filename: "a.dng", date: "2026-08-01")
        XCTAssertEqual(MuiBatchRenameModal.applyTemplate("{seq}", item: item, seq: 1), "001")
        XCTAssertEqual(MuiBatchRenameModal.applyTemplate("{seq}", item: item, seq: 42), "042")
        XCTAssertEqual(MuiBatchRenameModal.applyTemplate("{seq}", item: item, seq: 1234), "1234")
    }

    func testApplyTemplateOmitsCameraWhenNil() {
        let item = MuiBatchRenameSourceItem(id: "1", filename: "a.dng", date: "2026-08-01")
        XCTAssertEqual(MuiBatchRenameModal.applyTemplate("shot_{camera}", item: item, seq: 1), "shot_")
    }

    func testPreviewItemsMapsEachSourceItemWithIncrementingSequence() {
        let items = [
            MuiBatchRenameSourceItem(id: "1", filename: "IMG_0042.dng", date: "2026-08-01"),
            MuiBatchRenameSourceItem(id: "2", filename: "IMG_0043.dng", date: "2026-08-01"),
        ]
        let preview = MuiBatchRenameModal.previewItems(items: items, template: "{date}_{seq}", startNumber: 5)
        XCTAssertEqual(preview.map(\.after), ["2026-08-01_005", "2026-08-01_006"])
        XCTAssertEqual(preview.map(\.before), ["IMG_0042.dng", "IMG_0043.dng"])
    }
}
