import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class RenderRequestIdentityTests: XCTestCase {
  func testForwardingHandleIdentifiesItsOwnRequestAfterLaterInputs() async throws {
    // Videos take the metadata-only early return; this exercises the real
    // forwarding scheduler without decoding or writing any source file.
    let session = EditSession(asset: AssetRef(url: URL(fileURLWithPath: "/metadata-only.mov")))
    var requests: [Task<UInt64, Never>] = []
    for index in 1...40 {
      session.model.exposure = Double(index) / 10
      requests.append(try XCTUnwrap(session.latestRenderSchedule))
    }
    var generations: [UInt64] = []
    for request in requests { generations.append(await request.value) }
    XCTAssertEqual(Set(generations).count, 40, "Each input owns a distinct admitted generation")
    let retained = await requests[0].value
    XCTAssertEqual(retained, generations[0], "A newer input cannot redirect an earlier handle")
    await session.renderActor.cancelAll()
  }
}
