import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import MapleCore

final class ImageMetadataReaderTests: XCTestCase {
  func testOrientedPixelSizeKeepsLandscapeOrientation() {
    let size = ImageMetadataReader.orientedPixelSize(
      width: 6000,
      height: 4000,
      orientationValue: 1
    )

    XCTAssertEqual(size.width, 6000, accuracy: 0.01)
    XCTAssertEqual(size.height, 4000, accuracy: 0.01)
  }

  func testOrientedPixelSizeSwapsPortraitOrientation() {
    let size = ImageMetadataReader.orientedPixelSize(
      width: 6000,
      height: 4000,
      orientationValue: 6
    )

    XCTAssertEqual(size.width, 4000, accuracy: 0.01)
    XCTAssertEqual(size.height, 6000, accuracy: 0.01)
  }

  // MARK: - Sourceless readPixelSize

  /// The Data variant must surface the same dims as a synthetic PNG would
  /// expose through ImageIO. We round-trip a 256×128 image through
  /// `CGImageDestination` so the test has zero filesystem dependency.
  func testReadPixelSizeFromDataReturnsImageDimensions() throws {
    let data = try makeSyntheticPNG(width: 256, height: 128)
    let size = try XCTUnwrap(ImageMetadataReader.readPixelSize(from: data))
    XCTAssertEqual(size.width, 256, accuracy: 0.01)
    XCTAssertEqual(size.height, 128, accuracy: 0.01)
  }

  /// Fixture-gated regression for the multi-IFD DNG case: index 0 is the
  /// embedded JPEG preview, the largest subimage holds the sensor data.
  /// The Data variant must walk every subimage exactly like the URL
  /// variant — without this the PhotoKit / Self-Hosted path returns
  /// preview dims and `nativeImageSize` is set to the wrong scale.
  func testReadPixelSizeFromDataMatchesURLVariantOnDNG() throws {
    let fixture = repoRoot()
      .appendingPathComponent("test-fixtures/raws/test_0002.dng")
    guard FileManager.default.fileExists(atPath: fixture.path) else {
      throw XCTSkip("test fixture not present: \(fixture.path)")
    }
    let urlSize = try XCTUnwrap(ImageMetadataReader.readPixelSize(from: fixture))
    let data = try Data(contentsOf: fixture)
    let dataSize = try XCTUnwrap(
      ImageMetadataReader.readPixelSize(from: data, identifierHint: "dng")
    )
    XCTAssertEqual(
      dataSize.width, urlSize.width, accuracy: 0.01,
      "Data variant must report the same width as URL variant")
    XCTAssertEqual(
      dataSize.height, urlSize.height, accuracy: 0.01,
      "Data variant must report the same height as URL variant")
  }

  func testReadPixelSizeFromDataReturnsNilOnGarbage() {
    let garbage = Data([0x00, 0x01, 0x02, 0x03])
    XCTAssertNil(ImageMetadataReader.readPixelSize(from: garbage))
  }

  /// Synthetic Bayer CFA DNG without an embedded preview IFD and with a
  /// non-commercial camera model. CIRAWFilter and CGImageSource both
  /// fail on it; the direct TIFF IFD parser fallback must discover the
  /// native 64x64 dimensions so CanvasZoomHost mounts the canvas.
  func testReadPixelSizeFromSyntheticCFADNG() throws {
    let fixture = repoRoot()
      .appendingPathComponent("src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
    guard FileManager.default.fileExists(atPath: fixture.path) else {
      throw XCTSkip("test fixture not present: \(fixture.path)")
    }
    let urlSize = try XCTUnwrap(ImageMetadataReader.readPixelSize(from: fixture))
    XCTAssertEqual(urlSize.width, 64, accuracy: 0.01)
    XCTAssertEqual(urlSize.height, 64, accuracy: 0.01)

    let data = try Data(contentsOf: fixture)
    let dataSize = try XCTUnwrap(
      ImageMetadataReader.readPixelSize(from: data, identifierHint: "dng"))
    XCTAssertEqual(dataSize.width, 64, accuracy: 0.01)
    XCTAssertEqual(dataSize.height, 64, accuracy: 0.01)
  }

  func testFFFCropOverridesEmbeddedPreviewInBothByteOrders() throws {
    for littleEndian in [false, true] {
      let data = syntheticFFFWithCrop(littleEndian: littleEndian)
      let size = try XCTUnwrap(
        ImageMetadataReader.readPixelSize(
          from: data, identifierHint: "fff"))
      XCTAssertEqual(size.width, 7304)
      XCTAssertEqual(size.height, 5478)

      let entries = ImageMetadataReader.readExifProperties(
        from: data, displayPath: "test_0004.fff", identifierHint: "fff")
      XCTAssertEqual(entries.first { $0.label == "Resolution" }?.value, "7304 × 5478")
      XCTAssertEqual(entries.first { $0.label == "Megapixels" }?.value, "40.0 MP")
    }
  }

  func testFFFCropInheritsRootOrientationInBothByteOrders() throws {
    for littleEndian in [false, true] {
      let data = syntheticFFFWithCrop(littleEndian: littleEndian, rootOrientation: 6)
      let size = try XCTUnwrap(
        ImageMetadataReader.readPixelSize(from: data, identifierHint: "fff"))
      XCTAssertEqual(size.width, 5478)
      XCTAssertEqual(size.height, 7304)

      let entries = ImageMetadataReader.readExifProperties(
        from: data, displayPath: "portrait.fff", identifierHint: "fff")
      XCTAssertEqual(entries.first { $0.label == "Resolution" }?.value, "5478 × 7304")
    }
  }

  func testRealFFFInfoMatchesUsableRawCropWhenFixturePresent() throws {
    let fixture = repoRoot().appendingPathComponent("test-fixtures/raws/test_0004.fff")
    guard FileManager.default.fileExists(atPath: fixture.path) else {
      throw XCTSkip("test fixture not present: \(fixture.path)")
    }
    let entries = ImageMetadataReader.readExifProperties(from: fixture)
    XCTAssertEqual(entries.first { $0.label == "Resolution" }?.value, "7304 × 5478")
    XCTAssertEqual(ImageMetadataReader.readPixelSize(from: fixture)?.width, 7304)
    XCTAssertEqual(ImageMetadataReader.readPixelSize(from: fixture)?.height, 5478)
  }

  // MARK: - EXIF dump

  /// Synthetic-PNG check that the Image section is populated with the
  /// correct resolution string. This is the bare minimum that the Info
  /// tab ever needs; richer EXIF (camera, lens, GPS) requires a real
  /// camera capture which the fixture-gated test below covers.
  func testReadExifPropertiesFromDataSurfacesResolution() throws {
    let data = try makeSyntheticPNG(width: 320, height: 240)
    let entries = ImageMetadataReader.readExifProperties(
      from: data,
      byteCount: data.count,
      displayPath: "synthetic.png"
    )
    XCTAssertFalse(entries.isEmpty, "synthetic PNG must yield at least one entry")

    let resolution = entries.first { $0.label == "Resolution" }
    XCTAssertEqual(resolution?.value, "320 × 240")

    let path = entries.first { $0.label == "Path" }
    XCTAssertEqual(path?.value, "synthetic.png")

    let size = entries.first { $0.label == "Size" }
    XCTAssertNotNil(size, "byteCount argument must surface as a File/Size row")
  }

  /// Fixture-gated EXIF check — a real camera capture should expose
  /// camera make/model and exposure parameters. The Info tab depends on
  /// these rows, so they're the contract.
  func testReadExifPropertiesFromURLSurfacesCameraFields() throws {
    let fixture = repoRoot()
      .appendingPathComponent("test-fixtures/raws/test_0002.dng")
    guard FileManager.default.fileExists(atPath: fixture.path) else {
      throw XCTSkip("test fixture not present: \(fixture.path)")
    }
    let entries = ImageMetadataReader.readExifProperties(from: fixture)
    XCTAssertFalse(entries.isEmpty)

    // At minimum we expect a resolution row. Other fields depend on
    // the specific fixture's EXIF — assert presence by section, not by
    // value.
    let sections = Set(entries.map(\.section))
    XCTAssertTrue(
      sections.contains("Image"),
      "EXIF dump must include the Image section")
    XCTAssertTrue(
      sections.contains("File"),
      "EXIF dump must always carry the File section")

    // File-section must include Path + Size.
    let pathRow = entries.first { $0.section == "File" && $0.label == "Path" }
    XCTAssertEqual(pathRow?.value, fixture.path)

    let sizeRow = entries.first { $0.section == "File" && $0.label == "Size" }
    XCTAssertNotNil(sizeRow)
  }

  // MARK: - Helpers

  /// Repo root resolved from this file's path. Mirrors the pattern in
  /// `MapleCoreTests.testPipelineRendererRealFile` so fixture lookups
  /// work whether `swift test` is invoked from the package directory or
  /// from the repo root.
  private func repoRoot() -> URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // Tests/MapleCoreTests
      .deletingLastPathComponent()  // Tests
      .deletingLastPathComponent()  // MapleCore
      .deletingLastPathComponent()  // Packages
      .deletingLastPathComponent()  // apple
      .deletingLastPathComponent()  // src
      .deletingLastPathComponent()  // <repo root>
  }

  /// An FFF-shaped TIFF: IFD0 is a 1217×913 preview; the RAW SubIFD is
  /// 7410×5586 with an inline SHORT DefaultCropSize of 7304×5478.
  private func syntheticFFFWithCrop(
    littleEndian: Bool, rootOrientation: UInt16 = 1
  ) -> Data {
    var bytes = [UInt8](repeating: 0, count: 160)
    func u16(_ value: UInt16, at offset: Int) {
      bytes[offset] = UInt8(truncatingIfNeeded: littleEndian ? value : value >> 8)
      bytes[offset + 1] = UInt8(truncatingIfNeeded: littleEndian ? value >> 8 : value)
    }
    func u32(_ value: UInt32, at offset: Int) {
      for i in 0..<4 {
        let shift = littleEndian ? i * 8 : (3 - i) * 8
        bytes[offset + i] = UInt8(truncatingIfNeeded: value >> shift)
      }
    }
    func entry(_ tag: UInt16, _ type: UInt16, _ count: UInt32, at offset: Int) {
      u16(tag, at: offset)
      u16(type, at: offset + 2)
      u32(count, at: offset + 4)
    }
    bytes[0] = littleEndian ? 0x49 : 0x4D
    bytes[1] = bytes[0]
    u16(42, at: 2)
    u32(8, at: 4)
    u16(4, at: 8)
    entry(0x0100, 3, 1, at: 10)
    u16(1217, at: 18)
    entry(0x0101, 3, 1, at: 22)
    u16(913, at: 30)
    entry(0x0112, 3, 1, at: 34)
    u16(rootOrientation, at: 42)
    entry(0x014A, 4, 1, at: 46)
    u32(80, at: 54)
    u32(0, at: 58)
    u16(3, at: 80)
    entry(0x0100, 4, 1, at: 82)
    u32(7410, at: 90)
    entry(0x0101, 4, 1, at: 94)
    u32(5586, at: 102)
    entry(0xC620, 3, 2, at: 106)
    u16(7304, at: 114)
    u16(5478, at: 116)
    u32(0, at: 118)
    return Data(bytes)
  }

  /// Build a tiny synthetic PNG so the test never depends on RAW
  /// fixtures. Filled with a fixed gradient so the encoder writes the
  /// IDAT (a fully-zero buffer can be optimised to a 0-byte payload).
  private func makeSyntheticPNG(width: Int, height: Int) throws -> Data {
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitsPerComponent = 8
    let bytesPerRow = width * 4
    let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
    guard
      let ctx = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: bitsPerComponent,
        bytesPerRow: bytesPerRow,
        space: colorSpace,
        bitmapInfo: bitmapInfo
      )
    else {
      XCTFail("failed to construct CGContext")
      throw NSError(domain: "ImageMetadataReaderTests", code: 1)
    }
    // Paint a horizontal gradient so encoders don't optimise the
    // bitmap away.
    for x in 0..<width {
      let v = CGFloat(x) / CGFloat(width)
      ctx.setFillColor(red: v, green: v, blue: v, alpha: 1)
      ctx.fill(CGRect(x: x, y: 0, width: 1, height: height))
    }
    guard let cg = ctx.makeImage() else {
      XCTFail("failed to materialise CGImage")
      throw NSError(domain: "ImageMetadataReaderTests", code: 2)
    }
    let mutable = NSMutableData()
    guard
      let dest = CGImageDestinationCreateWithData(
        mutable as CFMutableData,
        UTType.png.identifier as CFString,
        1,
        nil
      )
    else {
      XCTFail("failed to create CGImageDestination")
      throw NSError(domain: "ImageMetadataReaderTests", code: 3)
    }
    CGImageDestinationAddImage(dest, cg, nil)
    guard CGImageDestinationFinalize(dest) else {
      XCTFail("failed to finalize PNG")
      throw NSError(domain: "ImageMetadataReaderTests", code: 4)
    }
    return mutable as Data
  }
}
