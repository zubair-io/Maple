import Foundation
import XCTest

@testable import MapleWatch

final class WatchCredentialLeaseTests: XCTestCase {
  func testLogoutRejectsLateRefreshPersistence() throws {
    let lease = WatchCredentialLease()
    var writes = 0
    try lease.whileActive { writes += 1 }
    XCTAssertTrue(lease.invalidate())
    XCTAssertThrowsError(try lease.whileActive { writes += 1 }) {
      XCTAssertTrue($0 is CancellationError)
    }
    XCTAssertEqual(writes, 1)
  }

  func testExpiryNotificationRunsOnlyOnce() {
    let lease = WatchCredentialLease()
    var notifications = 0
    XCTAssertTrue(lease.invalidate { notifications += 1 })
    XCTAssertFalse(lease.invalidate { notifications += 1 })
    XCTAssertEqual(notifications, 1)
  }

  func testLogoutWaitsForExistingWriteAndPreventsLaterWrites() {
    let lease = WatchCredentialLease()
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    let finished = expectation(description: "write completed")
    let loggedOut = expectation(description: "logout completed")
    DispatchQueue.global().async {
      try? lease.whileActive {
        entered.signal()
        _ = release.wait(timeout: .now() + 5)
      }
      finished.fulfill()
    }
    XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
    DispatchQueue.global().async {
      lease.invalidate()
      loggedOut.fulfill()
    }
    release.signal()
    wait(for: [finished, loggedOut], timeout: 5)
    XCTAssertThrowsError(try lease.whileActive {})
  }
}
