import XCTest

@testable import MapleCore

/// `FilesystemSource.writeXMP` is the batch/paste write path. It must leave
/// the same sidecar the editor's own confirmed save would: the metadata
/// block and every foreign region kept, only Maple's fields replaced.
final class FilesystemSourceWriteXMPTests: XCTestCase {
  private var directory: URL!
  private var raw: URL { directory.appendingPathComponent("photo.dng") }
  private var sidecar: URL { SidecarPath.sidecarURL(for: raw) }

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("filesystem-write-xmp-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try Data(repeating: 0xAB, count: 2048).write(to: raw)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: directory)
  }

  func testWriteXMPCreatesASidecarThatReadsBack() async throws {
    var model = AdjustmentModel.default
    model.exposure = 1.25
    let culling = CullingState(stars: 4)
    try await FilesystemSource().writeXMP(Sidecar(model: model, culling: culling), for: ref())

    let (readModel, readCulling) = try XMPParser.parse(data: try Data(contentsOf: sidecar))
    XCTAssertEqual(readModel.exposure, 1.25, accuracy: 0.0001)
    XCTAssertEqual(readCulling.stars, 4)
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted(),
      ["photo.dng", "photo.xmp"])
  }

  func testWriteXMPPreservesMetadataAndPassthroughOfTheExistingSidecar() async throws {
    let existing = NativeWorkflowControlFixture.input(exposure: 0, tag: "B")
    try Data(existing.utf8).write(to: sidecar)
    var model = AdjustmentModel.default
    model.exposure = 0.75
    let culling = CullingState(stars: 2)
    try await FilesystemSource().writeXMP(Sidecar(model: model, culling: culling), for: ref())

    let written = try String(contentsOf: sidecar, encoding: .utf8)
    XCTAssertNotEqual(written, existing)
    let (readModel, readCulling) = try XMPParser.parse(written)
    XCTAssertEqual(readModel.exposure, 0.75, accuracy: 0.0001)
    XCTAssertEqual(readCulling.stars, 2)
    XCTAssertEqual(XMPParser.parseMetadata(written).caption, "Caption B")
    XCTAssertTrue(
      written.contains(
        "<foreign:Audit xmlns:foreign=\"urn:maple:test\" z=\"B\" a=\"retained\"> B &amp; unchanged </foreign:Audit>"
      ), written)
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted(),
      ["photo.dng", "photo.xmp"])
  }

  func testWriteXMPWithoutAURLIsNotFound() async {
    do {
      try await FilesystemSource().writeXMP(
        Sidecar(model: .default, culling: CullingState()),
        for: ImageRef(id: "no-url", displayName: "photo.dng"))
      XCTFail("a URL-less reference has no sidecar location")
    } catch ImageSourceError.notFound(let id) {
      XCTAssertEqual(id, "no-url")
    } catch {
      XCTFail("expected notFound, got \(error)")
    }
  }

  private func ref() -> ImageRef {
    ImageRef(id: "fs-write-xmp", displayName: "photo.dng", url: raw)
  }
}
