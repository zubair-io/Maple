import XCTest

@testable import MapleCore

final class SMBRelocateJoinedSidecarTests: XCTestCase {
  private func fixture() async -> FakeSMBTransport {
    let transport = FakeSMBTransport()
    await transport.seed("raw", at: "/src/photo.CR3")
    await transport.seed("<original/>", at: "/src/photo.xmp")
    await transport.seed("jpg", at: "/dest/photo.JPG")
    await transport.seed("<original/>", at: "/dest/photo.xmp")
    return transport
  }

  func testJoinedSidecarChangedDuringPrimaryStagingRefusesTheMove() async throws {
    let transport = await fixture()
    await transport.setReplacementAtCopy(
      "/src/photo.CR3", item: "/dest/photo.xmp", contents: "<new edit/>")
    do {
      _ = try await SMBFileOperations.relocate(
        "/src/photo.CR3", to: "/dest", mode: .move, collision: .fail, transport: transport)
      XCTFail("A changed destination must not be joined")
    } catch {}
    let files = await transport.allFiles()
    XCTAssertEqual(files["/src/photo.CR3"], "raw")
    XCTAssertEqual(files["/src/photo.xmp"], "<original/>")
    XCTAssertEqual(files["/dest/photo.xmp"], "<new edit/>")
    XCTAssertNil(files["/dest/photo.CR3"])
  }

  func testJoinedSidecarChangedAfterPlanningKeepsTheSourceEditsDuringFinalize() async throws {
    let transport = await fixture()
    let plan = try await SMBFileOperations.planRelocate(
      "/src/photo.CR3", to: "/dest", mode: .move, collision: .fail, transport: transport)
    await transport.seed("<new edit/>", at: "/dest/photo.xmp")
    _ = await SMBFileOperations.finalizeRelocate(plan, transport: transport)
    let files = await transport.allFiles()
    XCTAssertEqual(files["/src/photo.xmp"], "<original/>")
    XCTAssertEqual(files["/dest/photo.xmp"], "<new edit/>")
    XCTAssertEqual(files["/dest/photo.CR3"], "raw")
  }
}
