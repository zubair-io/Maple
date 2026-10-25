import XCTest

@testable import MapleCore

/// Real files in a temp directory: the publication routine is what every
/// local sidecar writer trusts to never expose a partial or lost save.
final class XMPSidecarFilePublicationTests: XCTestCase {
  private var directory: URL!
  private var destination: URL { directory.appendingPathComponent("photo.xmp") }

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("xmp-publication-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: directory)
  }

  func testPublishWritesThroughStagedSiblingAndLeavesNoTemporaryFile() throws {
    let xml = NativeWorkflowControlFixture.input(exposure: 0.5)
    try XMPSidecarFilePublication.publish(xml, at: destination, durable: true)
    XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), xml)
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: directory.path), ["photo.xmp"])
    let staged = XMPSidecarFilePublication.stagingURL(for: destination)
    XCTAssertEqual(staged.deletingLastPathComponent(), destination.deletingLastPathComponent())
    XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path))
  }

  func testPublishReplacesAnExistingSidecarDurably() throws {
    try Data(NativeWorkflowControlFixture.input(exposure: 0).utf8).write(to: destination)
    let xml = NativeWorkflowControlFixture.input(exposure: 1.5, tag: "B")
    try XMPSidecarFilePublication.publish(xml, at: destination, durable: true)
    XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), xml)
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: directory.path), ["photo.xmp"])
  }

  func testFailureBetweenStagingAndRenameKeepsThePreviousSidecarByteIdentical() throws {
    let previous = Data(NativeWorkflowControlFixture.input(exposure: 0).utf8)
    try previous.write(to: destination)
    struct Interrupted: Error {}
    XCTAssertThrowsError(
      try XMPSidecarFilePublication.publish(
        NativeWorkflowControlFixture.input(exposure: 2), at: destination, durable: true
      ) { _, staged in
        XCTAssertTrue(FileManager.default.fileExists(atPath: staged.path))
        throw Interrupted()
      }
    ) { XCTAssertTrue($0 is Interrupted) }
    XCTAssertEqual(try Data(contentsOf: destination), previous)
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: directory.path), ["photo.xmp"])
  }

  func testConfirmExistingAcceptsIdenticalBytes() throws {
    let xml = NativeWorkflowControlFixture.input(exposure: 0.25)
    try Data(xml.utf8).write(to: destination)
    XCTAssertNoThrow(try XMPSidecarFilePublication.confirmExisting(xml, at: destination))
  }

  func testConfirmExistingRejectsAByteMismatch() throws {
    try Data(NativeWorkflowControlFixture.input(exposure: 0.25).utf8).write(to: destination)
    XCTAssertThrowsError(
      try XMPSidecarFilePublication.confirmExisting(
        NativeWorkflowControlFixture.input(exposure: 0.26), at: destination)
    ) { error in
      guard case .publishedContentMismatch(let url)? = error as? XMPStoreError else {
        return XCTFail("expected publishedContentMismatch, got \(error)")
      }
      XCTAssertEqual(url, destination)
    }
  }

  func testConfirmExistingRejectsAMissingSidecar() {
    XCTAssertThrowsError(
      try XMPSidecarFilePublication.confirmExisting("<x/>", at: destination))
  }
}
