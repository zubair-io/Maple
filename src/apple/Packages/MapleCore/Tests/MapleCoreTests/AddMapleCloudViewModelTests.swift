// AddMapleCloudViewModelTests.swift
import XCTest
import AuthenticationServices
@testable import MapleCore

@MainActor
final class AddMapleCloudViewModelTests: XCTestCase {
  // MARK: Bootstrap transitions

  func test_bootstrapNotClaimed_routesToOwnerClaim() async {
    let host = CloudHost.parse("myserver.com")!
    let flow = StubCloudAuthFlow(server: host.url)
    flow.bootstrapResult = .success(false)
    let vm = AddMapleCloudViewModel(makeFlow: { _ in flow })

    vm.domainInput = "myserver.com"
    await vm.continueFromIdle()

    XCTAssertEqual(vm.state, .needsOwnerClaim(host))
  }

  func test_bootstrapClaimed_routesToNeedsAuth() async {
    let host = CloudHost.parse("myserver.com")!
    let flow = StubCloudAuthFlow(server: host.url)
    flow.bootstrapResult = .success(true)
    let vm = AddMapleCloudViewModel(makeFlow: { _ in flow })

    vm.domainInput = "myserver.com"
    await vm.continueFromIdle()

    XCTAssertEqual(vm.state, .needsAuth(host))
  }

  func test_bootstrapNetworkError_routesToError() async {
    let host = CloudHost.parse("myserver.com")!
    let flow = StubCloudAuthFlow(server: host.url)
    flow.bootstrapResult = .failure(StubError.network("offline"))
    let vm = AddMapleCloudViewModel(makeFlow: { _ in flow })

    vm.domainInput = "myserver.com"
    await vm.continueFromIdle()

    if case .error(let msg, let recover) = vm.state {
      XCTAssertTrue(msg.contains("offline"))
      XCTAssertEqual(recover, .idle)
    } else {
      XCTFail("expected .error, got \(vm.state)")
    }
  }

  func test_invalidDomain_routesToError_withRecoverToIdle() async {
    let vm = AddMapleCloudViewModel(makeFlow: { _ in
      StubCloudAuthFlow(server: URL(string: "https://x")!)
    })
    vm.domainInput = ""
    await vm.continueFromIdle()

    if case .error(_, let recover) = vm.state {
      XCTAssertEqual(recover, .idle)
    } else {
      XCTFail("expected .error, got \(vm.state)")
    }
  }
}

// MARK: - Test doubles

enum StubError: Error, LocalizedError {
  case network(String)
  var errorDescription: String? {
    if case .network(let m) = self { return m }
    return nil
  }
}

final class StubCloudAuthFlow: CloudAuthFlow, @unchecked Sendable {
  let server: URL
  var bootstrapResult: Result<Bool, Error> = .failure(StubError.network("not configured"))
  var registerResult: Result<AuthVerifyResponse, Error> = .failure(StubError.network("not configured"))
  var loginResult: Result<AuthVerifyResponse, Error> = .failure(StubError.network("not configured"))

  init(server: URL) { self.server = server }

  func bootstrap() async throws -> Bool {
    try bootstrapResult.get()
  }
  func register(email: String, inviteCode: String?, deviceLabel: String,
                presentationAnchor: ASPresentationAnchor) async throws -> AuthVerifyResponse {
    try registerResult.get()
  }
  func login(email: String, presentationAnchor: ASPresentationAnchor) async throws -> AuthVerifyResponse {
    try loginResult.get()
  }
}
