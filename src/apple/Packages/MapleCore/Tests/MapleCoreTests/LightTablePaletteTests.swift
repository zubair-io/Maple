// LightTablePaletteTests.swift — the Light Table follows the system
// appearance: warm paper when light, the app's dark palette when dark (#5473).

import MapleCloudKit
import SwiftUI
import XCTest

final class LightTablePaletteTests: XCTestCase {
  private let dark = LightTablePalette(
    paperTop: .gray, paperBottom: .black, ink: .white, mat: .white)

  func test_lightAppearance_usesTheWarmPaper() {
    XCTAssertEqual(LightTablePalette.forScheme(.light, dark: dark), .warmPaper)
  }

  func test_darkAppearance_usesTheSuppliedDarkPalette() {
    XCTAssertEqual(LightTablePalette.forScheme(.dark, dark: dark), dark)
  }

  func test_warmPaper_keepsTheOriginalLook() {
    XCTAssertEqual(
      LightTablePalette.warmPaper,
      LightTablePalette(
        paperTop: Color(red: 0xfd / 255, green: 0xfc / 255, blue: 0xf9 / 255),
        paperBottom: Color(red: 0xe6 / 255, green: 0xe1 / 255, blue: 0xd5 / 255),
        ink: Color(red: 0x1c / 255, green: 0x19 / 255, blue: 0x17 / 255),
        mat: .white))
  }
}
