// AddMapleCloudViewModelTests.swift
import XCTest
@testable import MapleCore

@MainActor
final class AddMapleCloudViewModelTests: XCTestCase {

  // MARK: continueFromIdle

  func test_continueFromIdle_validDomain_routesToLoadingWebview() {
    let vm = AddMapleCloudViewModel()
    vm.domainInput = "myserver.com"
    vm.continueFromIdle()
    XCTAssertEqual(vm.state, .loadingWebview(CloudHost.parse("myserver.com")!))
  }

  func test_continueFromIdle_emptyDomain_routesToError() {
    let vm = AddMapleCloudViewModel()
    vm.domainInput = ""
    vm.continueFromIdle()
    if case .error(_, let recover) = vm.state {
      XCTAssertEqual(recover, .idle)
    } else {
      XCTFail("expected error, got \(vm.state)")
    }
  }

  func test_continueFromIdle_pathInDomain_routesToError() {
    let vm = AddMapleCloudViewModel()
    vm.domainInput = "myserver.com/api/auth"
    vm.continueFromIdle()
    if case .error = vm.state {} else { XCTFail("expected error") }
  }

  // MARK: webviewFailed

  func test_webviewFailed_fromLoading_routesToError() {
    let vm = AddMapleCloudViewModel()
    vm.domainInput = "myserver.com"
    vm.continueFromIdle()
    vm.webviewFailed(message: "DNS lookup failed")
    if case .error(let msg, let recover) = vm.state {
      XCTAssertEqual(msg, "DNS lookup failed")
      XCTAssertEqual(recover, .idle)
    } else {
      XCTFail("expected error, got \(vm.state)")
    }
  }

  func test_webviewFailed_fromIdle_isNoop() {
    let vm = AddMapleCloudViewModel()
    vm.webviewFailed(message: "unexpected")
    XCTAssertEqual(vm.state, .idle)
  }

  // MARK: bridgeReceivedAuthSuccess

  func test_bridgeReceivedAuthSuccess_fromLoading_routesToSignedIn() {
    let vm = AddMapleCloudViewModel()
    vm.domainInput = "myserver.com"
    vm.continueFromIdle()
    let user = AuthUser(id: "u1", email: "alice@example.com", role: "owner")
    vm.bridgeReceivedAuthSuccess(accessToken: "AT",
                                 refreshToken: "RT",
                                 user: user)
    let host = CloudHost.parse("myserver.com")!
    XCTAssertEqual(vm.state, .signedIn(host,
      tokens: AuthTokens(access: "AT", refresh: "RT"),
      user: user))
  }

  func test_bridgeReceivedAuthSuccess_fromIdle_isNoop() {
    let vm = AddMapleCloudViewModel()
    let user = AuthUser(id: "u1", email: "alice@example.com", role: "owner")
    vm.bridgeReceivedAuthSuccess(accessToken: "AT",
                                 refreshToken: "RT",
                                 user: user)
    // Bridge messages outside the loading window are ignored — defensive
    // against duplicate or out-of-order webview events.
    XCTAssertEqual(vm.state, .idle)
  }

  // MARK: callback contract

  func test_signedIn_invokesOnSignedInCallbackOnce() {
    let recorder = SignedInRecorder()
    let vm = AddMapleCloudViewModel(onSignedIn: { url, tokens, user in
      recorder.record(url: url, tokens: tokens, user: user)
    })
    vm.domainInput = "myserver.com"
    vm.continueFromIdle()
    let user = AuthUser(id: "u9", email: "callback@example.com", role: "owner")
    vm.bridgeReceivedAuthSuccess(accessToken: "AT",
                                 refreshToken: "RT",
                                 user: user)
    XCTAssertEqual(recorder.calls.count, 1)
    XCTAssertEqual(recorder.calls.first?.url,
                   CloudHost.parse("myserver.com")!.url)
    XCTAssertEqual(recorder.calls.first?.tokens,
                   AuthTokens(access: "AT", refresh: "RT"))
    XCTAssertEqual(recorder.calls.first?.user, user)
  }

  // MARK: cancel

  func test_cancelBeforeBridge_suppressesCallback() {
    let recorder = SignedInRecorder()
    let vm = AddMapleCloudViewModel(onSignedIn: { url, tokens, user in
      recorder.record(url: url, tokens: tokens, user: user)
    })
    vm.domainInput = "myserver.com"
    vm.continueFromIdle()
    vm.cancel()  // user dismissed sheet
    let user = AuthUser(id: "u9", email: "racer@example.com", role: "owner")
    vm.bridgeReceivedAuthSuccess(accessToken: "AT",
                                 refreshToken: "RT",
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
    vm.continueFromIdle()
    vm.webviewFailed(message: "TLS")
    vm.retryFromError()
    XCTAssertEqual(vm.state, .idle)
  }
}

/// Helper that records onSignedIn invocations.
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
