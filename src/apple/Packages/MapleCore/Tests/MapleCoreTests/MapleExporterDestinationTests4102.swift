import CoreImage
import ImageIO
import XCTest

@testable import MapleCore

extension MapleExporterTests {
  @MainActor
  func testExportRejectsOriginalPathAndAuthenticAliasesBeforeRendering() async throws {
    let root = try exportTestDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    for format in ExportFileFormat.allCases {
      let folder = root.appendingPathComponent(format.rawValue)
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      let original = folder.appendingPathComponent("original.\(format.fileExtension)")
      let sourceBytes = try writeOriginal(original, format: format)
      let session = EditSession(asset: AssetRef(url: original))
      let fileAlias = folder.appendingPathComponent("alias.\(format.fileExtension)")
      try FileManager.default.createSymbolicLink(at: fileAlias, withDestinationURL: original)
      let hardlink = folder.appendingPathComponent("hardlink.\(format.fileExtension)")
      try FileManager.default.linkItem(at: original, to: hardlink)
      let parentAlias = root.appendingPathComponent("\(format.rawValue)-alias")
      try FileManager.default.createSymbolicLink(at: parentAlias, withDestinationURL: folder)
      let dotted = URL(fileURLWithPath: folder.path + "/./original.\(format.fileExtension)")
      let destinations = [
        original, dotted, fileAlias, hardlink,
        parentAlias.appendingPathComponent(original.lastPathComponent),
      ]
      for destination in destinations {
        do {
          try await MapleExporter.exportToFile(
            session: session,
            options: ExportOptions(format: format), destination: destination)
          XCTFail("Original identity must be refused: \(destination.path)")
        } catch ExportError.originalDestination {
          XCTAssertEqual(try Data(contentsOf: original), sourceBytes)
          XCTAssertEqual(try Data(contentsOf: destination), sourceBytes)
          XCTAssertEqual(
            ExportError.originalDestination.localizedDescription,
            "Choose a different export name or folder. Original photos cannot be overwritten.")
        }
      }
      XCTAssertEqual(
        try FileManager.default.destinationOfSymbolicLink(atPath: fileAlias.path), original.path)
    }
  }

  @MainActor
  func testOriginalProtectionPrecedesAnActualDecodeFailure() async throws {
    let root = try exportTestDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let original = root.appendingPathComponent("damaged-original.png")
    let bytes = Data("damaged raster original".utf8)
    try bytes.write(to: original)
    let session = EditSession(asset: AssetRef(url: original))
    do {
      try await MapleExporter.exportToFile(
        session: session,
        options: ExportOptions(format: .png), destination: original)
      XCTFail("Source identity must be refused before a decode can begin")
    } catch ExportError.originalDestination {
      XCTAssertEqual(try Data(contentsOf: original), bytes)
    }
    do {
      _ = try await MapleExporter.exportData(session: session, options: ExportOptions(format: .png))
      XCTFail("Control must prove that attempting this decode actually fails")
    } catch RenderError.pipelineFailed {
      XCTAssertEqual(try Data(contentsOf: original), bytes)
    }
  }

  @MainActor
  func testIndependentExportAndNewSymlinkParentDestinationPreserveOriginal() async throws {
    let root = try exportTestDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let original = root.appendingPathComponent("original.png")
    let sourceBytes = try writeOriginal(original, format: .png)
    var model = AdjustmentModel.default
    model.exposure = 1
    let session = EditSession(asset: AssetRef(url: original), model: model)
    let parentAlias = root.appendingPathComponent("alias-folder")
    try FileManager.default.createSymbolicLink(at: parentAlias, withDestinationURL: root)
    let options = ExportOptions(format: .png, maxSidePixels: 32)
    let destinations = [
      root.appendingPathComponent("existing.png"),
      parentAlias.appendingPathComponent("new.png"),
    ]
    try Data("existing independent destination".utf8).write(to: destinations[0])
    XCTAssertFalse(FileManager.default.fileExists(atPath: destinations[1].path))
    for destination in destinations {
      try await MapleExporter.exportToFile(
        session: session, options: options, destination: destination)
      XCTAssertEqual(try Data(contentsOf: original), sourceBytes)
      let imageSource = try XCTUnwrap(CGImageSourceCreateWithURL(destination as CFURL, nil))
      let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(imageSource, 0, nil))
      XCTAssertEqual(image.width, 32)
      XCTAssertEqual(image.height, 24)
      XCTAssertEqual(CGImageSourceGetType(imageSource) as String?, "public.png")
    }
    await session.releaseTransientMemory()
  }

  @MainActor
  func testPostRenderPublicationRechecksDestinationIdentity() async throws {
    let root = try exportTestDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let original = root.appendingPathComponent("original.png")
    let sourceBytes = try writeOriginal(original, format: .png)
    let destination = root.appendingPathComponent("export.png")
    try MapleExporter.validateExportDestination(destination, original: original)
    var model = AdjustmentModel.default
    model.exposure = 1
    let session = EditSession(asset: AssetRef(url: original), model: model)
    let rendered = try await MapleExporter.exportData(
      session: session, options: ExportOptions(format: .png))
    // An initially independent destination becomes a source alias before publication.
    try FileManager.default.createSymbolicLink(at: destination, withDestinationURL: original)
    XCTAssertThrowsError(
      try MapleExporter.writeExportData(rendered, destination: destination, original: original)
    ) { error in
      guard case ExportError.originalDestination = error else {
        return XCTFail("Unexpected error: \(error)")
      }
    }
    XCTAssertEqual(try Data(contentsOf: original), sourceBytes)
    XCTAssertEqual(try Data(contentsOf: destination), sourceBytes)
    await session.releaseTransientMemory()
  }

  @MainActor
  func testFormerWriteBoundaryReallyOverwritesDisposableOriginal() async throws {
    let root = try exportTestDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let original = root.appendingPathComponent("original.png")
    let sourceBytes = try writeOriginal(original, format: .png)
    var model = AdjustmentModel.default
    model.exposure = 1
    let session = EditSession(asset: AssetRef(url: original), model: model)
    let rendered = try await MapleExporter.exportData(
      session: session, options: ExportOptions(format: .png))
    XCTAssertNotEqual(rendered, sourceBytes, "Control must contain a visible edit")
    // Exact former publication primitive, only on this disposable test original.
    try rendered.write(to: original, options: .atomic)
    XCTAssertNotEqual(try Data(contentsOf: original), sourceBytes)
    await session.releaseTransientMemory()
  }

  private func exportTestDirectory() throws -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "maple-export-4102-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  private func writeOriginal(_ destination: URL, format: ExportFileFormat) throws -> Data {
    let image = CIImage(color: CIColor(red: 0.25, green: 0.25, blue: 0.25))
      .cropped(to: CGRect(x: 0, y: 0, width: 64, height: 48))
    let bytes = try MapleExporter.encodeImage(image, options: ExportOptions(format: format))
    try bytes.write(to: destination)
    return bytes
  }
}
