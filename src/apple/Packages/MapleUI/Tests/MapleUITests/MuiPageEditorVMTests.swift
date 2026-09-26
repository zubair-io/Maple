import XCTest

@testable import MapleUI

final class MuiPageEditorVMTests: XCTestCase {
  func testSelectedPhotoSuppliesHeaderCanvasAndInfo() {
    let url = URL(fileURLWithPath: "/tmp/selected.dng")
    let photos = [
      MuiPageEditorPhoto(id: "first", url: nil, alt: "First"),
      MuiPageEditorPhoto(id: "selected", url: url, alt: "Selected"),
    ]

    let vm = buildMuiPageEditorVM(photos: photos, activePhotoId: "selected")

    XCTAssertEqual(vm.title, "Selected")
    XCTAssertEqual(vm.photoURL, url)
    XCTAssertEqual(vm.infoTitle, "Selected")
  }

  func testMissingSelectionUsesEmptyState() {
    let photos = [MuiPageEditorPhoto(id: "first", url: nil, alt: "First")]

    let vm = buildMuiPageEditorVM(photos: photos, activePhotoId: "missing")

    XCTAssertEqual(vm.title, "Editor")
    XCTAssertNil(vm.photoURL)
    XCTAssertEqual(vm.infoTitle, "No photo selected")
  }
}
