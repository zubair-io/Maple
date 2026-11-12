import XCTest

@testable import MapleCore

/// #5050: `SMBSource` carries a stacked JPEG by running the RAW's engine call and then the JPEG's,
/// so the shared sidecar must follow the ownership rule across the two calls.
final class RawJpegStackSMBFileOperationsTests: XCTestCase {
  private func seeded() async -> FakeSMBTransport {
    let transport = FakeSMBTransport()
    await transport.seed("raw-bytes", at: "/Source/IMG_1.CR3")
    await transport.seed("jpeg-bytes", at: "/Source/IMG_1.JPG")
    await transport.seed("<xmp>edits</xmp>", at: "/Source/IMG_1.xmp")
    return transport
  }

  func testMovingTheRawThenTheJpegMovesTheSharedSidecarOnce() async throws {
    let transport = await seeded()

    _ = try await SMBFileOperations.relocate(
      "/Source/IMG_1.CR3", to: "/Album", mode: .move, collision: .fail, transport: transport)
    let sidecarAfterRaw = await transport.fileExists(at: "/Source/IMG_1.xmp")
    _ = try await SMBFileOperations.relocate(
      "/Source/IMG_1.JPG", to: "/Album", mode: .move, collision: .fail, transport: transport)

    XCTAssertTrue(sidecarAfterRaw, "the JPEG still reads the sidecar after the RAW leaves")
    let files = await transport.allFiles()
    XCTAssertEqual(
      Set(files.keys.filter { !$0.contains("/.maple") }),
      ["/Album/IMG_1.CR3", "/Album/IMG_1.JPG", "/Album/IMG_1.xmp"])
    XCTAssertEqual(files["/Album/IMG_1.xmp"], "<xmp>edits</xmp>")
  }

  func testRenamingTheRawThenTheJpegLeavesOneSidecarUnderTheNewStem() async throws {
    let transport = await seeded()

    _ = try await SMBFileOperations.relocate(
      "/Source/IMG_1.CR3", to: "/Source", newBasename: "Trip.CR3", mode: .move,
      collision: .fail, transport: transport)
    _ = try await SMBFileOperations.relocate(
      "/Source/IMG_1.JPG", to: "/Source", newBasename: "Trip.JPG", mode: .move,
      collision: .fail, transport: transport)

    let files = await transport.allFiles()
    XCTAssertEqual(
      Set(files.keys.filter { !$0.contains("/.maple") }),
      ["/Source/Trip.CR3", "/Source/Trip.JPG", "/Source/Trip.xmp"])
  }
}
