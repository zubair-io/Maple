import CoreGraphics
import SwiftUI
import XCTest

@testable import MapleUI

final class MuiMaterialSymbolsTests: XCTestCase {
  func testBundledLibraryIncludesRoundedDesignOutlines() throws {
    for name in ["lan", "public", "photo_camera", "tune", "undo", "warning", "star"] {
      let path = try XCTUnwrap(MuiMaterialSymbols.path(for: name), name)
      XCTAssertFalse(path.isEmpty, name)
      let rect = path.boundingRect
      XCTAssertGreaterThan(rect.width, 0, name)
      XCTAssertGreaterThan(rect.height, 0, name)
      XCTAssertGreaterThanOrEqual(rect.minX, 0, name)
      XCTAssertGreaterThanOrEqual(rect.minY, 0, name)
      XCTAssertLessThanOrEqual(rect.maxX, 24, name)
      XCTAssertLessThanOrEqual(rect.maxY, 24, name)
    }
    XCTAssertNil(MuiMaterialSymbols.path(for: "not_a_material_symbol"))
  }

  func testEveryBundledNameHasAnOutline() {
    XCTAssertGreaterThan(MuiMaterialSymbols.glyphs.count, 4_000)
    for name in MuiMaterialSymbols.glyphs.keys {
      XCTAssertNotNil(MuiMaterialSymbols.path(for: name), name)
    }
  }

  func testRepeatedLookupKeepsIdenticalGeometry() throws {
    let first = try XCTUnwrap(MuiMaterialSymbols.path(for: "public"))
    let second = try XCTUnwrap(MuiMaterialSymbols.path(for: "public"))
    XCTAssertEqual(first, second)
  }

  @MainActor
  func testMaterialIconsRenderWithRouteTintInBothAppearances() throws {
    for scheme in [ColorScheme.light, .dark] {
      let renderer = ImageRenderer(
        content: HStack(spacing: 0) {
          MuiIcon(name: "lan", size: .md, color: .init(red: 0, green: 1, blue: 0))
          MuiIcon(name: "public", size: .md, color: .init(red: 1, green: 0.5, blue: 0))
        }
        .environment(\.colorScheme, scheme))
      renderer.scale = 1
      let image = try XCTUnwrap(renderer.cgImage)
      XCTAssertEqual(image.width, 48)
      XCTAssertEqual(image.height, 24)
      let pixels = try rgba(image)
      let left = coloredPixels(pixels, range: 0..<24, width: 48)
      let right = coloredPixels(pixels, range: 24..<48, width: 48)
      XCTAssertGreaterThan(left.count, 50)
      XCTAssertGreaterThan(right.count, 50)
      XCTAssertTrue(left.allSatisfy { $0.1 > $0.0 && $0.1 > $0.2 })
      XCTAssertTrue(right.allSatisfy { $0.0 > $0.1 && $0.1 > $0.2 })
    }
  }

  private func rgba(_ image: CGImage) throws -> [UInt8] {
    var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
    try pixels.withUnsafeMutableBytes { bytes in
      let context = try XCTUnwrap(
        CGContext(
          data: bytes.baseAddress, width: image.width, height: image.height,
          bitsPerComponent: 8, bytesPerRow: image.width * 4,
          space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
      context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    }
    return pixels
  }

  private func coloredPixels(_ pixels: [UInt8], range: Range<Int>, width: Int) -> [(
    UInt8, UInt8, UInt8
  )] {
    (0..<24).flatMap { y in
      range.compactMap { x in
        let i = (y * width + x) * 4
        return pixels[i + 3] > 128 ? (pixels[i], pixels[i + 1], pixels[i + 2]) : nil
      }
    }
  }
}
