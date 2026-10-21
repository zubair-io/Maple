import Foundation
import XCTest

@testable import MapleWatch

final class WatchSessionEndingTests: XCTestCase {
  func testOnlyTheFirstEnderClaimsTheSession() {
    let ending = WatchSessionEnding()
    XCTAssertTrue(ending.claim())
    XCTAssertFalse(ending.claim())
  }

  func testConcurrentEndersClaimExactlyOnce() {
    let ending = WatchSessionEnding()
    let claims = DispatchQueue(label: "claims")
    var won = 0
    DispatchQueue.concurrentPerform(iterations: 64) { _ in
      if ending.claim() { claims.sync { won += 1 } }
    }
    XCTAssertEqual(won, 1)
  }
}
