import XCTest

@testable import MapleCore

final class EditorLayoutTests: XCTestCase {
  func testPhoneKeepsCompactControlFamilyAndCanvasDensityAfterRotation() {
    for width: CGFloat in [320, 390, 430, 768, 844, 932, 1024, 1100] {
      let layout = EditorLayout(width: width, idiom: .phone, regularHorizontalSizeClass: false)
      XCTAssertTrue(layout.usesPhoneControls, "iPhone width \(width)")
      // This also keeps the canvas's crop insets, floating header and
      // filmstrip policy compact on a wide landscape iPhone.
      XCTAssertEqual(layout.density, .phone, "iPhone width \(width)")
    }
  }

  func testDuoInnerDisplayUsesFloatingInspectorInBothOrientations() {
    for width: CGFloat in [669, 951] {
      let layout = EditorLayout(width: width, idiom: .phone, regularHorizontalSizeClass: true)
      XCTAssertFalse(layout.usesPhoneControls)
      XCTAssertEqual(layout.density, .tablet)
    }
  }

  func testDuoSplitViewReturnsToCompactControls() {
    let layout = EditorLayout(width: 402, idiom: .phone, regularHorizontalSizeClass: false)
    XCTAssertTrue(layout.usesPhoneControls)
    XCTAssertEqual(layout.density, .phone)
  }

  func testNarrowIPadAndMacKeepSharedInspectorDespiteCompactDensity() {
    for idiom: MapleDeviceIdiom in [.pad, .mac] {
      for width: CGFloat in [320, 600, 767] {
        let layout = EditorLayout(width: width, idiom: idiom, regularHorizontalSizeClass: false)
        XCTAssertFalse(layout.usesPhoneControls, "\(idiom) width \(width)")
        XCTAssertEqual(layout.density, .phone)
      }
    }
  }

  func testIPadAndMacReflowSharedInspectorAtExistingBoundaries() {
    for idiom: MapleDeviceIdiom in [.pad, .mac] {
      for (width, density): (CGFloat, MapleLayout) in [
        (768, .tablet), (1024, .tablet), (1025, .desktop), (1366, .desktop),
      ] {
        let layout = EditorLayout(width: width, idiom: idiom, regularHorizontalSizeClass: true)
        XCTAssertFalse(layout.usesPhoneControls)
        XCTAssertEqual(layout.density, density)
      }
    }
  }
}
