// AddMapleCloudViewModelTests.swift
import XCTest
@testable import MapleCore

@MainActor
final class AddMapleCloudViewModelTests: XCTestCase {

  // MARK: continueFromIdle

  func test_continueFromIdle_validDomain_routesToAuthenticating() {
    let vm = AddMapleCloudViewModel()
    vm.domainInput = "myserver.com"
    let host = vm.continueFromIdle()
    XCTAssertEqual(host, CloudHost.parse("myserver.com"))
    XCTAssertEqual(vm.state, .authenticating(CloudHost.parse("myserver.com")!))
  }

  func test_continueFromIdle_emptyDomain_routesToError() {
    let vm = AddMapleCloudViewModel()
    vm.domainInput = ""
    let host = vm.continueFromIdle()
    XCTAssertNil(host)
    if case .error(_, let recover) = vm.state {
      XCTAssertEqual(recover, .idle)
    } else {
      XCTFail("expected error, got \(vm.state)")
    }
  }

  func test_continueFromIdle_pathInDomain_routesToError() {
    let vm = AddMapleCloudViewModel()
    vm.domainInput = "myserver.com/api/auth"
    let host = vm.continueFromIdle()
    XCTAssertNil(host)
    if case .error = vm.state {} else { XCTFail("expected error") }
  }

  // MARK: driver callbacks

  func test_driverFailed_fromAuthenticating_routesToError() {
    let vm = AddMapleCloudViewModel()
    vm.domainInput = "myserver.com"
    _ = vm.continueFromIdle()
    vm.driverFailed(message: "DNS lookup failed")
    if case .error(let msg, let recover) = vm.state {
      XCTAssertEqual(msg, "DNS lookup failed")
      XCTAssertEqual(recover, .idle)
    } else {
      XCTFail("expected error, got \(vm.state)")
    }
  }

  func test_driverFailed_fromIdle_isNoop() {
    let vm = AddMapleCloudViewModel()
    vm.driverFailed(message: "unexpected")
    XCTAssertEqual(vm.state, .idle)
  }

  func test_driverCancelled_fromAuthenticating_returnsToIdle() {
    // Explicit user cancellation does NOT show an error panel —
    // the user just wanted to back out.
    let vm = AddMapleCloudViewModel()
    vm.domainInput = "myserver.com"
    _ = vm.continueFromIdle()
    vm.driverCancelled()
    XCTAssertEqual(vm.state, .idle)
  }

  func test_driverReceivedAuthSuccess_fromAuthenticating_routesToSignedIn() {
    let vm = AddMapleCloudViewModel()
    vm.domainInput = "myserver.com"
    _ = vm.continueFromIdle()
    let user = AuthUser(id: "u1", email: "alice@example.com", role: "owner")
    vm.driverReceivedAuthSuccess(tokens: AuthTokens(access: "AT", refresh: "RT"),
                                 user: user)
    let host = CloudHost.parse("myserver.com")!
    XCTAssertEqual(vm.state, .signedIn(host,
      tokens: AuthTokens(access: "AT", refresh: "RT"), user: user))
  }

  func test_driverReceivedAuthSuccess_fromIdle_isNoop() {
    let vm = AddMapleCloudViewModel()
    let user = AuthUser(id: "u1", email: "alice@example.com", role: "owner")
    vm.driverReceivedAuthSuccess(tokens: AuthTokens(access: "AT", refresh: "RT"),
                                 user: user)
    // Ignored — state machine doesn't trust callbacks outside the
    // authenticating window.
    XCTAssertEqual(vm.state, .idle)
  }

  // MARK: callback contract

  func test_signedIn_invokesOnSignedInCallbackOnce() {
    let recorder = SignedInRecorder()
    let vm = AddMapleCloudViewModel(onSignedIn: { url, tokens, user in
      recorder.record(url: url, tokens: tokens, user: user)
    })
    vm.domainInput = "myserver.com"
    _ = vm.continueFromIdle()
    let user = AuthUser(id: "u9", email: "callback@example.com", role: "owner")
    vm.driverReceivedAuthSuccess(tokens: AuthTokens(access: "AT", refresh: "RT"),
                                 user: user)
    XCTAssertEqual(recorder.calls.count, 1)
    XCTAssertEqual(recorder.calls.first?.url, CloudHost.parse("myserver.com")!.url)
    XCTAssertEqual(recorder.calls.first?.tokens, AuthTokens(access: "AT", refresh: "RT"))
    XCTAssertEqual(recorder.calls.first?.user, user)
  }

  // MARK: cancel race

  func test_cancelBeforeDriver_suppressesCallback() {
    let recorder = SignedInRecorder()
    let vm = AddMapleCloudViewModel(onSignedIn: { url, tokens, user in
      recorder.record(url: url, tokens: tokens, user: user)
    })
    vm.domainInput = "myserver.com"
    _ = vm.continueFromIdle()
    vm.cancel()  // user dismissed sheet
    let user = AuthUser(id: "u9", email: "racer@example.com", role: "owner")
    vm.driverReceivedAuthSuccess(tokens: AuthTokens(access: "AT", refresh: "RT"),
                                 user: user)
    XCTAssertEqual(recorder.calls.count, 0)
  }

  func test_cancel_isIdempotent() {
    let vm = AddMapleCloudViewModel()
    vm.cancel()
    vm.cancel()
    vm.cancel()
    XCTAssertEqual(vm.state, .idle)
  }

  // MARK: retryFromError

  func test_retryFromError_returnsToRecoverableTarget() {
    let vm = AddMapleCloudViewModel()
    vm.domainInput = "myserver.com"
    _ = vm.continueFromIdle()
    vm.driverFailed(message: "TLS")
    vm.retryFromError()
    XCTAssertEqual(vm.state, .idle)
  }
}

@MainActor
final class SignedInRecorder {
  struct Call: Equatable {
    let url: URL
    let tokens: AuthTokens
    let user: AuthUser
  }
  var calls: [Call] = []
  func record(url: URL, tokens: AuthTokens, user: AuthUser) {
    calls.append(Call(url: url, tokens: tokens, user: user))
  }
}
