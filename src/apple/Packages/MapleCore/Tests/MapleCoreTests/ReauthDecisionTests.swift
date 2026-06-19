import XCTest
@testable import MapleCore

/// #1381 — the decision logic behind "after a cloud load attempt, should the
/// UI present sign-in?". Kept as a pure function so it's testable without the
/// SwiftUI shell (which is the part Apple CI can't exercise).
final class ReauthDecisionTests: XCTestCase {
  func testSignedInWithNoErrorDoesNotPrompt() {
    XCTAssertFalse(ReauthDecision.needsSignIn(isSignedIn: true, loadError: nil))
  }

  func testNotSignedInPrompts() {
    // A failed refresh during the load cleared credentials.
    XCTAssertTrue(ReauthDecision.needsSignIn(isSignedIn: false, loadError: nil))
  }

  func testUnauthorizedErrorPrompts() {
    XCTAssertTrue(
      ReauthDecision.needsSignIn(isSignedIn: true,
                                 loadError: AuthClientError.unauthorized(body: "")))
  }

  func testForbiddenErrorPrompts() {
    XCTAssertTrue(
      ReauthDecision.needsSignIn(isSignedIn: true,
                                 loadError: AuthClientError.forbidden(body: "")))
  }

  func testNetworkErrorDoesNotPrompt() {
    // Offline / transport failure — credentials may still be valid, so don't
    // throw the user into a sign-in sheet they can't complete offline.
    XCTAssertFalse(
      ReauthDecision.needsSignIn(isSignedIn: true,
                                 loadError: AuthClientError.network(URLError(.timedOut))))
  }

  func testServerErrorDoesNotPrompt() {
    XCTAssertFalse(
      ReauthDecision.needsSignIn(isSignedIn: true,
                                 loadError: AuthClientError.http(status: 500, body: "")))
  }

  func testNonAuthClientErrorDoesNotPrompt() {
    struct Boom: Error {}
    XCTAssertFalse(ReauthDecision.needsSignIn(isSignedIn: true, loadError: Boom()))
  }
}
