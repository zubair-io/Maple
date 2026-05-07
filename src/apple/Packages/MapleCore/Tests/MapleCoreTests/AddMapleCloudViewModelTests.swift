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

  // MARK: Owner claim

  func test_claimOwner_success_routesToSignedIn() async {
    let host = CloudHost.parse("myserver.com")!
    let flow = StubCloudAuthFlow(server: host.url)
    let user = AuthUser(id: "u1", email: "owner@example.com", role: "owner")
    flow.registerResult = .success(AuthVerifyResponse(
      access_token: "ACCESS", refresh_token: "REFRESH", user: user))
    let vm = AddMapleCloudViewModel(makeFlow: { _ in flow })

    vm.state = .needsOwnerClaim(host)
    vm.emailInput = "owner@example.com"
    await vm.claimOwner()

    XCTAssertEqual(vm.state, .signedIn(host,
      tokens: AuthTokens(access: "ACCESS", refresh: "REFRESH"),
      user: user))
  }

  func test_claimOwner_failure_routesToErrorRecoveringToOwnerClaim() async {
    let host = CloudHost.parse("myserver.com")!
    let flow = StubCloudAuthFlow(server: host.url)
    flow.registerResult = .failure(StubError.network("user cancelled"))
    let vm = AddMapleCloudViewModel(makeFlow: { _ in flow })

    vm.state = .needsOwnerClaim(host)
    vm.emailInput = "owner@example.com"
    await vm.claimOwner()

    if case .error(_, let recover) = vm.state {
      XCTAssertEqual(recover, .needsOwnerClaim(host))
    } else { XCTFail("expected error") }
  }

  func test_claimOwner_emptyEmail_routesToError() async {
    let host = CloudHost.parse("myserver.com")!
    let flow = StubCloudAuthFlow(server: host.url)
    let vm = AddMapleCloudViewModel(makeFlow: { _ in flow })

    vm.state = .needsOwnerClaim(host)
    vm.emailInput = "  "
    await vm.claimOwner()

    if case .error = vm.state { } else { XCTFail("expected error") }
  }

  // MARK: Sign in

  func test_chooseSignIn_routesToEnteringSignInEmail() async {
    let host = CloudHost.parse("myserver.com")!
    let vm = AddMapleCloudViewModel(makeFlow: { _ in StubCloudAuthFlow(server: host.url) })
    vm.state = .needsAuth(host)
    vm.chooseSignIn()
    XCTAssertEqual(vm.state, .enteringSignInEmail(host))
  }

  func test_signIn_success_routesToSignedIn() async {
    let host = CloudHost.parse("myserver.com")!
    let flow = StubCloudAuthFlow(server: host.url)
    let user = AuthUser(id: "u2", email: "alice@example.com", role: "member")
    flow.loginResult = .success(AuthVerifyResponse(
      access_token: "A", refresh_token: "R", user: user))
    let vm = AddMapleCloudViewModel(makeFlow: { _ in flow })

    vm.state = .enteringSignInEmail(host)
    vm.emailInput = "alice@example.com"
    await vm.signIn()

    XCTAssertEqual(vm.state, .signedIn(host,
      tokens: AuthTokens(access: "A", refresh: "R"), user: user))
  }

  func test_signIn_failure_routesToErrorRecoveringToEmailEntry() async {
    let host = CloudHost.parse("myserver.com")!
    let flow = StubCloudAuthFlow(server: host.url)
    flow.loginResult = .failure(StubError.network("no credential"))
    let vm = AddMapleCloudViewModel(makeFlow: { _ in flow })

    vm.state = .enteringSignInEmail(host)
    vm.emailInput = "alice@example.com"
    await vm.signIn()

    if case .error(_, let recover) = vm.state {
      XCTAssertEqual(recover, .enteringSignInEmail(host))
    } else { XCTFail("expected error") }
  }

  func test_signIn_emptyEmail_routesToError() async {
    let host = CloudHost.parse("myserver.com")!
    let vm = AddMapleCloudViewModel(makeFlow: { _ in StubCloudAuthFlow(server: host.url) })
    vm.state = .enteringSignInEmail(host)
    vm.emailInput = ""
    await vm.signIn()
    if case .error = vm.state { } else { XCTFail("expected error") }
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
