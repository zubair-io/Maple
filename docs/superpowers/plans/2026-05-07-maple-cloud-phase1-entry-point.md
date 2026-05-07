# Maple Cloud Phase 1 — Entry Point Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken Settings → Connect-to-Server flow with a single domain-only sheet that routes through owner-claim, sign-in, and invite-join via a state-machine view model. No sidebar or timeline changes in this phase.

**Architecture:** Introduce a small `CloudAuthFlow` protocol over the methods the new view model needs from `AuthClient` (bootstrap, register, login). A new `@Observable AddMapleCloudViewModel` drives an explicit state machine — every transition is testable, every error has a visible state. A new SwiftUI `AddMapleCloudSheet` renders one panel per state. Replace the three existing sheet presentations (`SelfHostedPickerSheet`, `JoinWithInviteView`, `SignInView`) in `MapleApp.swift` and `AppShell.swift`, then delete the old sheets.

**Tech Stack:** Swift, SwiftUI, AuthenticationServices, XCTest, Swift Concurrency.

**Spec:** [`docs/superpowers/specs/2026-05-07-maple-cloud-on-apple-design.md`](../specs/2026-05-07-maple-cloud-on-apple-design.md)

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/CloudAuthFlow.swift` | Create | Protocol surface for the methods the view model needs. `AuthClient` conformance. |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/CloudHost.swift` | Create | Value type that normalizes a user-typed domain ("myserver.com") into a `URL`. |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AddMapleCloudState.swift` | Create | The state enum that drives the flow. |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AddMapleCloudViewModel.swift` | Create | `@Observable` state machine. No UI imports. |
| `src/apple/Packages/MapleCore/Tests/MapleCoreTests/AddMapleCloudViewModelTests.swift` | Create | Unit tests for every transition. |
| `src/apple/Packages/MapleCore/Tests/MapleCoreTests/CloudHostTests.swift` | Create | Unit tests for input normalization. |
| `src/apple/Maple/Views/AddMapleCloudSheet.swift` | Create | SwiftUI view, one panel per state. |
| `src/apple/Maple/Views/AppShell.swift` | Modify | Replace the three sheet bindings with one. |
| `src/apple/Maple/MapleApp.swift` | Modify | Replace `SelfHostedPickerSheet` in `SelfHostedSettingsTab`. |
| `src/apple/Maple/Views/SignInView.swift` | Delete | Logic merged into the new view model. |
| `src/apple/Maple/Views/JoinWithInviteView.swift` | Delete | Logic merged into the new view model. |
| `src/apple/Maple/Views/AppShell.swift` (`SelfHostedPickerSheet`) | Delete | Lives at the bottom of `AppShell.swift`; remove the struct. |

---

## Task 1: Define `CloudAuthFlow` protocol

The view model needs to call three methods on a server: `bootstrap`, `register`, `login`. To unit-test the state machine without a real network, we extract those three behind a protocol and let `AuthClient` conform.

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/CloudAuthFlow.swift`

- [ ] **Step 1: Write the failing test**

Create `src/apple/Packages/MapleCore/Tests/MapleCoreTests/CloudAuthFlowTests.swift`:

```swift
import XCTest
@testable import MapleCore

final class CloudAuthFlowTests: XCTestCase {
    /// AuthClient must conform to CloudAuthFlow so the view model can
    /// take it as a dependency. This test compiles iff the conformance
    /// exists; no behavior assertions yet.
    func test_AuthClient_conformsToCloudAuthFlow() {
        let url = URL(string: "https://example.test")!
        let client: any CloudAuthFlow = AuthClient(server: url)
        XCTAssertNotNil(client)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/apple/Packages/MapleCore && swift test --filter CloudAuthFlowTests`

Expected: FAIL with `cannot convert value of type 'AuthClient' to specified type 'any CloudAuthFlow'`.

- [ ] **Step 3: Write the protocol and conformance**

Create `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/CloudAuthFlow.swift`:

```swift
// CloudAuthFlow.swift
//
// Narrow protocol over AuthClient's bootstrap/register/login surface so the
// AddMapleCloudViewModel state machine can be unit-tested without a network.
// Keep this surface minimal — anything else the view model needs is a smell
// that the state machine is doing too much.

import AuthenticationServices
import Foundation

public protocol CloudAuthFlow: Sendable {
  /// Server this client is bound to.
  var server: URL { get }

  /// `GET /api/auth/bootstrap` — returns whether the server has any users yet.
  func bootstrap() async throws -> Bool

  /// `POST /api/auth/register/{options,verify}` driving the WebAuthn create
  /// ceremony via `ASAuthorizationController`. `inviteCode` is required for
  /// non-owner registration on a claimed server.
  func register(email: String,
                inviteCode: String?,
                deviceLabel: String,
                presentationAnchor: ASPresentationAnchor) async throws -> AuthVerifyResponse

  /// `POST /api/auth/login/{options,verify}` driving the WebAuthn assertion
  /// ceremony via `ASAuthorizationController`.
  func login(email: String,
             presentationAnchor: ASPresentationAnchor) async throws -> AuthVerifyResponse
}

extension AuthClient: CloudAuthFlow {}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/apple/Packages/MapleCore && swift test --filter CloudAuthFlowTests`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Auth/CloudAuthFlow.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/CloudAuthFlowTests.swift
git commit -m "$(cat <<'EOF'
feat(maple-core): add CloudAuthFlow protocol over AuthClient

Narrow surface (bootstrap/register/login) so the new
AddMapleCloudViewModel can be unit-tested without a network.
AuthClient conforms via extension.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `CloudHost` — normalize the user-typed domain

Users will type `myserver.com`, `https://maple.example`, or `Maple.Example/  ` — we need one canonical way to turn that into a URL or surface "that's not valid". This isolates parsing from the state machine.

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/CloudHost.swift`
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/CloudHostTests.swift`

- [ ] **Step 1: Write the failing tests**

```swift
// CloudHostTests.swift
import XCTest
@testable import MapleCore

final class CloudHostTests: XCTestCase {
  func test_bareDomain_addsHttps() {
    XCTAssertEqual(CloudHost.parse("myserver.com")?.url.absoluteString,
                   "https://myserver.com")
  }
  func test_explicitHttps_preserved() {
    XCTAssertEqual(CloudHost.parse("https://maple.example")?.url.absoluteString,
                   "https://maple.example")
  }
  func test_explicitHttp_preserved() {
    XCTAssertEqual(CloudHost.parse("http://localhost:3000")?.url.absoluteString,
                   "http://localhost:3000")
  }
  func test_whitespace_trimmed() {
    XCTAssertEqual(CloudHost.parse("  myserver.com  ")?.url.absoluteString,
                   "https://myserver.com")
  }
  func test_uppercase_lowercased() {
    XCTAssertEqual(CloudHost.parse("Maple.Example")?.url.absoluteString,
                   "https://maple.example")
  }
  func test_trailingSlash_stripped() {
    XCTAssertEqual(CloudHost.parse("myserver.com/")?.url.absoluteString,
                   "https://myserver.com")
  }
  func test_emptyString_isNil() {
    XCTAssertNil(CloudHost.parse(""))
  }
  func test_whitespaceOnly_isNil() {
    XCTAssertNil(CloudHost.parse("   "))
  }
  func test_pathInInput_isNil() {
    // We only accept hostnames + optional port. Paths are user error.
    XCTAssertNil(CloudHost.parse("myserver.com/api/auth"))
  }
  func test_displayHost_stripsScheme() {
    XCTAssertEqual(CloudHost.parse("https://maple.example")?.displayHost,
                   "maple.example")
  }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src/apple/Packages/MapleCore && swift test --filter CloudHostTests`

Expected: FAIL — `cannot find 'CloudHost' in scope`.

- [ ] **Step 3: Write the type**

```swift
// CloudHost.swift
//
// Parses a user-typed domain into a canonical URL.
//
// Accepted inputs (case-insensitive, trim whitespace):
//   "myserver.com"
//   "https://myserver.com"
//   "http://localhost:3000"
//   "myserver.com/"
// Rejected: empty, whitespace-only, anything with a path component beyond "/".

import Foundation

public struct CloudHost: Equatable, Sendable {
  public let url: URL

  /// Hostname stripped of scheme/trailing slash, suitable for sidebar labels
  /// and bootstrap UI.
  public var displayHost: String {
    var s = url.host ?? url.absoluteString
    if let port = url.port { s += ":\(port)" }
    return s
  }

  public static func parse(_ raw: String) -> CloudHost? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !trimmed.isEmpty else { return nil }

    let withScheme: String
    if trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") {
      withScheme = trimmed
    } else {
      withScheme = "https://" + trimmed
    }

    // Strip a single trailing slash; reject anything else after the host.
    let stripped = withScheme.hasSuffix("/") ? String(withScheme.dropLast()) : withScheme

    guard let url = URL(string: stripped),
          let host = url.host, !host.isEmpty,
          (url.path.isEmpty || url.path == "/")
    else { return nil }

    return CloudHost(url: url)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src/apple/Packages/MapleCore && swift test --filter CloudHostTests`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Auth/CloudHost.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/CloudHostTests.swift
git commit -m "$(cat <<'EOF'
feat(maple-core): add CloudHost domain normalizer

Trims whitespace, lowercases, adds https:// when scheme missing,
strips trailing slash, rejects paths/empty strings. Used by the
new AddMapleCloudViewModel to keep parsing out of the state machine.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `AddMapleCloudState` enum

The single source of truth for what the sheet shows. Each case carries the data it needs; transitions are the view model's job (Task 4+).

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AddMapleCloudState.swift`

- [ ] **Step 1: Write the type**

No test for this — it's an enum with no behavior. Tests come with the view model.

```swift
// AddMapleCloudState.swift
//
// State enum for the AddMapleCloud flow. Every UI panel in the new sheet
// corresponds to exactly one of these cases. Transitions live in
// AddMapleCloudViewModel.

import Foundation

public enum AddMapleCloudState: Equatable, Sendable {
  /// Initial — user is typing the domain.
  case idle

  /// Network call to /api/auth/bootstrap is in flight.
  case checkingBootstrap(CloudHost)

  /// Server has no users yet — user must create the owner account.
  case needsOwnerClaim(CloudHost)

  /// Owner-claim WebAuthn registration is in flight.
  case registeringOwner(CloudHost, email: String)

  /// Server is claimed — user must choose Sign in or Join with invite.
  case needsAuth(CloudHost)

  /// Sign-in path — collecting email.
  case enteringSignInEmail(CloudHost)

  /// Sign-in WebAuthn assertion is in flight.
  case signingIn(CloudHost, email: String)

  /// Invite path — collecting email + code.
  case enteringInviteDetails(CloudHost)

  /// Invite-join WebAuthn registration is in flight.
  case registeringInvitee(CloudHost, email: String, code: String)

  /// Terminal success state. The view dismisses on entry.
  case signedIn(CloudHost, tokens: AuthTokens, user: AuthUser)

  /// Inline error for the panel that triggered the failed action. The
  /// associated `recoverableTo` is the state we go back to on Retry.
  case error(message: String, recoverableTo: AddMapleCloudState)

  // Equatable indirection — Swift can't synthesize Equatable on enums with
  // associated values that include other instances of the same enum, so we
  // implement it manually for the `error` case.
  public static func == (lhs: AddMapleCloudState, rhs: AddMapleCloudState) -> Bool {
    switch (lhs, rhs) {
    case (.idle, .idle): return true
    case (.checkingBootstrap(let a), .checkingBootstrap(let b)): return a == b
    case (.needsOwnerClaim(let a), .needsOwnerClaim(let b)): return a == b
    case (.registeringOwner(let a, let ea), .registeringOwner(let b, let eb)):
      return a == b && ea == eb
    case (.needsAuth(let a), .needsAuth(let b)): return a == b
    case (.enteringSignInEmail(let a), .enteringSignInEmail(let b)): return a == b
    case (.signingIn(let a, let ea), .signingIn(let b, let eb)):
      return a == b && ea == eb
    case (.enteringInviteDetails(let a), .enteringInviteDetails(let b)): return a == b
    case (.registeringInvitee(let a, let ea, let ca), .registeringInvitee(let b, let eb, let cb)):
      return a == b && ea == eb && ca == cb
    case (.signedIn(let a, let ta, let ua), .signedIn(let b, let tb, let ub)):
      return a == b && ta == tb && ua == ub
    case (.error(let ma, let ra), .error(let mb, let rb)):
      return ma == mb && ra == rb
    default: return false
    }
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src/apple/Packages/MapleCore && swift build`

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AddMapleCloudState.swift
git commit -m "$(cat <<'EOF'
feat(maple-core): add AddMapleCloudState enum

Single source of truth for the AddMapleCloud sheet's UI panels.
Each case maps to one panel; transitions live in the view model
in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `AddMapleCloudViewModel` skeleton + bootstrap transition

Wire up the view model with the bootstrap call. This is the first transition: `idle` → `checkingBootstrap` → `needsOwnerClaim` or `needsAuth` or `error`.

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AddMapleCloudViewModel.swift`
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/AddMapleCloudViewModelTests.swift`

- [ ] **Step 1: Write the failing tests**

```swift
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
    vm.domainInput = "" // empty -> CloudHost.parse returns nil
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src/apple/Packages/MapleCore && swift test --filter AddMapleCloudViewModelTests`

Expected: FAIL — `cannot find 'AddMapleCloudViewModel' in scope`.

- [ ] **Step 3: Write the view model skeleton**

```swift
// AddMapleCloudViewModel.swift
//
// State machine for the AddMapleCloud sheet. UI-agnostic: this type does NOT
// import SwiftUI. The sheet observes `state` and `domainInput` and calls the
// transition methods on the view model.

import AuthenticationServices
import Foundation
import Observation
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor
@Observable
public final class AddMapleCloudViewModel {
  /// Current state. The sheet renders one panel per case.
  public private(set) var state: AddMapleCloudState = .idle

  /// Bound to the domain text field on the idle panel.
  public var domainInput: String = ""

  /// Bound to the email text field on the various email panels.
  public var emailInput: String = ""

  /// Bound to the invite-code text field on the invite panel.
  public var inviteInput: String = ""

  /// Factory for the auth flow client. Tests inject a stub; production
  /// passes `AuthClient(server:)`.
  private let makeFlow: (URL) -> any CloudAuthFlow

  /// Current ASPresentationAnchor provider — set by the sheet on appear.
  /// Tests can leave it nil because they stub the network calls; production
  /// SwiftUI sets it from the key window.
  public var presentationAnchor: () -> ASPresentationAnchor = {
    ASPresentationAnchor()
  }

  /// Device label for the WebAuthn `register` ceremony. Defaults to a
  /// platform-appropriate name; tests can override.
  public var deviceLabel: () -> String = AddMapleCloudViewModel.defaultDeviceLabel

  public init(makeFlow: @escaping (URL) -> any CloudAuthFlow = { AuthClient(server: $0) }) {
    self.makeFlow = makeFlow
  }

  // MARK: - Transitions

  /// Idle → checkingBootstrap → (needsOwnerClaim | needsAuth | error).
  public func continueFromIdle() async {
    guard let host = CloudHost.parse(domainInput) else {
      state = .error(message: "Enter a domain like myserver.com",
                     recoverableTo: .idle)
      return
    }
    state = .checkingBootstrap(host)
    let flow = makeFlow(host.url)
    do {
      let claimed = try await flow.bootstrap()
      state = claimed ? .needsAuth(host) : .needsOwnerClaim(host)
    } catch {
      state = .error(message: error.localizedDescription,
                     recoverableTo: .idle)
    }
  }

  /// Resets the error state back to its `recoverableTo` target. Bound to
  /// the "Try again" button on the error panel.
  public func retryFromError() {
    if case .error(_, let target) = state { state = target }
  }

  // MARK: - Platform

  static func defaultDeviceLabel() -> String {
    #if os(macOS)
    return Host.current().localizedName ?? "Mac"
    #else
    return UIDevice.current.name
    #endif
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src/apple/Packages/MapleCore && swift test --filter AddMapleCloudViewModelTests`

Expected: PASS — all 4 tests in this task.

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AddMapleCloudViewModel.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/AddMapleCloudViewModelTests.swift
git commit -m "$(cat <<'EOF'
feat(maple-core): AddMapleCloudViewModel + bootstrap transition

@Observable state machine driving the new AddMapleCloudSheet.
First transition implemented: idle → checkingBootstrap →
(needsOwnerClaim | needsAuth | error). Tests cover happy paths,
network errors, and invalid-domain input.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Owner-claim transition

When the server is unclaimed, user enters their email and we drive the WebAuthn registration ceremony.

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AddMapleCloudViewModel.swift`
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/AddMapleCloudViewModelTests.swift`

- [ ] **Step 1: Write the failing tests** (append to `AddMapleCloudViewModelTests.swift`):

```swift
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src/apple/Packages/MapleCore && swift test --filter AddMapleCloudViewModelTests`

Expected: FAIL — `claimOwner` doesn't exist.

- [ ] **Step 3: Add the transition** to `AddMapleCloudViewModel.swift` (under `// MARK: - Transitions`):

```swift
  /// needsOwnerClaim → registeringOwner → (signedIn | error).
  public func claimOwner() async {
    guard case .needsOwnerClaim(let host) = state else { return }
    let email = emailInput.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !email.isEmpty else {
      state = .error(message: "Enter an email address",
                     recoverableTo: .needsOwnerClaim(host))
      return
    }
    state = .registeringOwner(host, email: email)
    let flow = makeFlow(host.url)
    do {
      let resp = try await flow.register(email: email,
                                         inviteCode: nil,
                                         deviceLabel: deviceLabel(),
                                         presentationAnchor: presentationAnchor())
      state = .signedIn(host,
                        tokens: AuthTokens(access: resp.access_token,
                                           refresh: resp.refresh_token),
                        user: resp.user)
    } catch {
      state = .error(message: error.localizedDescription,
                     recoverableTo: .needsOwnerClaim(host))
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src/apple/Packages/MapleCore && swift test --filter AddMapleCloudViewModelTests`

Expected: PASS — all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AddMapleCloudViewModel.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/AddMapleCloudViewModelTests.swift
git commit -m "$(cat <<'EOF'
feat(maple-core): AddMapleCloud owner-claim transition

needsOwnerClaim → registeringOwner → signedIn | error.
Empty-email guard, network-error recovery to the claim panel.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Sign-in transition

Existing-user path: from `needsAuth`, user picks "Sign in", enters email, we drive the WebAuthn assertion ceremony.

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AddMapleCloudViewModel.swift`
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/AddMapleCloudViewModelTests.swift`

- [ ] **Step 1: Write the failing tests** (append):

```swift
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
```

- [ ] **Step 2: Run tests, verify failure**

Run: `cd src/apple/Packages/MapleCore && swift test --filter AddMapleCloudViewModelTests`

Expected: FAIL — `chooseSignIn` and `signIn` don't exist.

- [ ] **Step 3: Add transitions** to `AddMapleCloudViewModel.swift`:

```swift
  /// needsAuth → enteringSignInEmail.
  public func chooseSignIn() {
    if case .needsAuth(let host) = state {
      emailInput = ""
      state = .enteringSignInEmail(host)
    }
  }

  /// enteringSignInEmail → signingIn → (signedIn | error).
  public func signIn() async {
    guard case .enteringSignInEmail(let host) = state else { return }
    let email = emailInput.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !email.isEmpty else {
      state = .error(message: "Enter an email address",
                     recoverableTo: .enteringSignInEmail(host))
      return
    }
    state = .signingIn(host, email: email)
    let flow = makeFlow(host.url)
    do {
      let resp = try await flow.login(email: email,
                                      presentationAnchor: presentationAnchor())
      state = .signedIn(host,
                        tokens: AuthTokens(access: resp.access_token,
                                           refresh: resp.refresh_token),
                        user: resp.user)
    } catch {
      state = .error(message: error.localizedDescription,
                     recoverableTo: .enteringSignInEmail(host))
    }
  }
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd src/apple/Packages/MapleCore && swift test --filter AddMapleCloudViewModelTests`

Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AddMapleCloudViewModel.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/AddMapleCloudViewModelTests.swift
git commit -m "$(cat <<'EOF'
feat(maple-core): AddMapleCloud sign-in transition

needsAuth → enteringSignInEmail → signingIn → signedIn | error.
Bootstraps existing-user passkey login from a pre-seeded email.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Invite-join transition

New-user-on-claimed-server path: from `needsAuth`, user picks "Join with invite", enters email + 8-char code, we drive WebAuthn registration with the invite code.

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AddMapleCloudViewModel.swift`
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/AddMapleCloudViewModelTests.swift`

- [ ] **Step 1: Write the failing tests** (append):

```swift
  // MARK: Invite join

  func test_chooseJoinWithInvite_routesToEnteringInviteDetails() {
    let host = CloudHost.parse("myserver.com")!
    let vm = AddMapleCloudViewModel(makeFlow: { _ in StubCloudAuthFlow(server: host.url) })
    vm.state = .needsAuth(host)
    vm.chooseJoinWithInvite()
    XCTAssertEqual(vm.state, .enteringInviteDetails(host))
  }

  func test_invite_success_routesToSignedIn() async {
    let host = CloudHost.parse("myserver.com")!
    let flow = StubCloudAuthFlow(server: host.url)
    let user = AuthUser(id: "u3", email: "bob@example.com", role: "member")
    flow.registerResult = .success(AuthVerifyResponse(
      access_token: "A", refresh_token: "R", user: user))
    let vm = AddMapleCloudViewModel(makeFlow: { _ in flow })

    vm.state = .enteringInviteDetails(host)
    vm.emailInput = "bob@example.com"
    vm.inviteInput = "AB12CD34"
    await vm.joinWithInvite()

    XCTAssertEqual(vm.state, .signedIn(host,
      tokens: AuthTokens(access: "A", refresh: "R"), user: user))
  }

  func test_invite_emptyEmail_routesToError() async {
    let host = CloudHost.parse("myserver.com")!
    let vm = AddMapleCloudViewModel(makeFlow: { _ in StubCloudAuthFlow(server: host.url) })
    vm.state = .enteringInviteDetails(host)
    vm.emailInput = ""
    vm.inviteInput = "AB12CD34"
    await vm.joinWithInvite()
    if case .error = vm.state { } else { XCTFail("expected error") }
  }

  func test_invite_wrongCodeLength_routesToError() async {
    let host = CloudHost.parse("myserver.com")!
    let vm = AddMapleCloudViewModel(makeFlow: { _ in StubCloudAuthFlow(server: host.url) })
    vm.state = .enteringInviteDetails(host)
    vm.emailInput = "bob@example.com"
    vm.inviteInput = "SHORT"
    await vm.joinWithInvite()
    if case .error = vm.state { } else { XCTFail("expected error") }
  }
```

- [ ] **Step 2: Run tests, verify failure**

Run: `cd src/apple/Packages/MapleCore && swift test --filter AddMapleCloudViewModelTests`

Expected: FAIL — methods don't exist.

- [ ] **Step 3: Add transitions** to `AddMapleCloudViewModel.swift`:

```swift
  /// needsAuth → enteringInviteDetails.
  public func chooseJoinWithInvite() {
    if case .needsAuth(let host) = state {
      emailInput = ""
      inviteInput = ""
      state = .enteringInviteDetails(host)
    }
  }

  /// enteringInviteDetails → registeringInvitee → (signedIn | error).
  public func joinWithInvite() async {
    guard case .enteringInviteDetails(let host) = state else { return }
    let email = emailInput.trimmingCharacters(in: .whitespacesAndNewlines)
    let code = inviteInput.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    guard !email.isEmpty else {
      state = .error(message: "Enter an email address",
                     recoverableTo: .enteringInviteDetails(host))
      return
    }
    guard code.count == 8 else {
      state = .error(message: "Invite code is 8 characters",
                     recoverableTo: .enteringInviteDetails(host))
      return
    }
    state = .registeringInvitee(host, email: email, code: code)
    let flow = makeFlow(host.url)
    do {
      let resp = try await flow.register(email: email,
                                         inviteCode: code,
                                         deviceLabel: deviceLabel(),
                                         presentationAnchor: presentationAnchor())
      state = .signedIn(host,
                        tokens: AuthTokens(access: resp.access_token,
                                           refresh: resp.refresh_token),
                        user: resp.user)
    } catch {
      state = .error(message: error.localizedDescription,
                     recoverableTo: .enteringInviteDetails(host))
    }
  }
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd src/apple/Packages/MapleCore && swift test --filter AddMapleCloudViewModelTests`

Expected: PASS — 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AddMapleCloudViewModel.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/AddMapleCloudViewModelTests.swift
git commit -m "$(cat <<'EOF'
feat(maple-core): AddMapleCloud invite-join transition

needsAuth → enteringInviteDetails → registeringInvitee →
signedIn | error. 8-char code length guard, network-error
recovery to the invite-details panel.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Token persistence on `signedIn`

When the state machine reaches `.signedIn`, the caller (the sheet) must (a) persist tokens via `TokenStore.save`, (b) update or create an `AuthSession` for the host, and (c) register the host with `SelfHostedCredentialStore` so the sidebar's existing self-hosted list picks it up. Phase 2 will replace `SelfHostedCredentialStore` with `CloudServerRegistry`; for Phase 1 we keep using it so the sidebar stays untouched.

We expose this through a callback on the view model rather than baking I/O into it — keeps the view model fully unit-testable.

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AddMapleCloudViewModel.swift`
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/AddMapleCloudViewModelTests.swift`

- [ ] **Step 1: Write the failing test** (append):

```swift
  // MARK: Side-effect callback

  func test_signedIn_invokesOnSignedInCallbackOnce() async {
    let host = CloudHost.parse("myserver.com")!
    let flow = StubCloudAuthFlow(server: host.url)
    let user = AuthUser(id: "u9", email: "callback@example.com", role: "owner")
    flow.bootstrapResult = .success(false)
    flow.registerResult = .success(AuthVerifyResponse(
      access_token: "AT", refresh_token: "RT", user: user))

    var calls: [(URL, AuthTokens, AuthUser)] = []
    let vm = AddMapleCloudViewModel(
      makeFlow: { _ in flow },
      onSignedIn: { url, tokens, user in
        calls.append((url, tokens, user))
      })

    vm.domainInput = "myserver.com"
    await vm.continueFromIdle()
    vm.emailInput = "callback@example.com"
    await vm.claimOwner()

    XCTAssertEqual(calls.count, 1)
    XCTAssertEqual(calls.first?.0, host.url)
    XCTAssertEqual(calls.first?.1, AuthTokens(access: "AT", refresh: "RT"))
    XCTAssertEqual(calls.first?.2, user)
  }
```

- [ ] **Step 2: Run, verify failure**

Run: `cd src/apple/Packages/MapleCore && swift test --filter AddMapleCloudViewModelTests`

Expected: FAIL — `onSignedIn` parameter doesn't exist.

- [ ] **Step 3: Add the callback**

Modify `AddMapleCloudViewModel.swift`. Update the init and add a `setSignedIn` helper:

```swift
  /// Side-effect callback — invoked exactly once when state transitions
  /// to `.signedIn`. The sheet uses it to persist tokens, register the
  /// server with the existing credential store, and dismiss itself.
  /// Tests can pass a closure that records calls.
  public typealias OnSignedIn = @MainActor (URL, AuthTokens, AuthUser) -> Void

  private let onSignedIn: OnSignedIn

  public init(makeFlow: @escaping (URL) -> any CloudAuthFlow = { AuthClient(server: $0) },
              onSignedIn: @escaping OnSignedIn = { _, _, _ in }) {
    self.makeFlow = makeFlow
    self.onSignedIn = onSignedIn
  }
```

Then update each transition that sets `.signedIn` to call the callback:

```swift
  // Helper used by claimOwner/signIn/joinWithInvite. Centralizes the
  // signedIn transition so the callback only fires once and from one place.
  private func transitionToSignedIn(_ host: CloudHost,
                                    response resp: AuthVerifyResponse) {
    let tokens = AuthTokens(access: resp.access_token, refresh: resp.refresh_token)
    state = .signedIn(host, tokens: tokens, user: resp.user)
    onSignedIn(host.url, tokens, resp.user)
  }
```

Replace the three sites that currently inline the transition (`claimOwner`, `signIn`, `joinWithInvite`) with `transitionToSignedIn(host, response: resp)`. Example for `claimOwner`:

```swift
      let resp = try await flow.register(email: email,
                                         inviteCode: nil,
                                         deviceLabel: deviceLabel(),
                                         presentationAnchor: presentationAnchor())
      transitionToSignedIn(host, response: resp)
```

(Apply the same change in `signIn` and `joinWithInvite`.)

- [ ] **Step 4: Run, verify pass**

Run: `cd src/apple/Packages/MapleCore && swift test --filter AddMapleCloudViewModelTests`

Expected: PASS — 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AddMapleCloudViewModel.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/AddMapleCloudViewModelTests.swift
git commit -m "$(cat <<'EOF'
feat(maple-core): AddMapleCloud onSignedIn callback

Centralizes the signedIn transition through one private helper
and exposes a single onSignedIn callback so the sheet can persist
tokens and refresh the sidebar without baking I/O into the view
model. Test verifies the callback fires exactly once with the
correct (URL, tokens, user) tuple.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `AddMapleCloudSheet` SwiftUI view

The view is a thin layer over the view model — one panel per state. No business logic in the view.

**Files:**
- Create: `src/apple/Maple/Views/AddMapleCloudSheet.swift`

- [ ] **Step 1: Write the view**

(No unit test for SwiftUI view bodies. Manual smoke test in Task 13.)

```swift
// AddMapleCloudSheet.swift
//
// Single sheet that drives the entire AddMapleCloud flow. Renders one panel
// per AddMapleCloudViewModel state. The view contains zero business logic —
// every action calls a method on the view model.

import SwiftUI
import AuthenticationServices
import MapleCore

struct AddMapleCloudSheet: View {
  let onDismiss: () -> Void
  let onSignedIn: @MainActor (URL, AuthTokens, AuthUser) -> Void

  @State private var vm: AddMapleCloudViewModel

  init(prefilledDomain: String = "",
       onDismiss: @escaping () -> Void,
       onSignedIn: @escaping @MainActor (URL, AuthTokens, AuthUser) -> Void) {
    self.onDismiss = onDismiss
    self.onSignedIn = onSignedIn
    let viewModel = AddMapleCloudViewModel(onSignedIn: onSignedIn)
    viewModel.domainInput = prefilledDomain
    _vm = State(wrappedValue: viewModel)
  }

  var body: some View {
    VStack(spacing: 16) {
      panel
    }
    .padding(28)
    .frame(minWidth: 420, minHeight: 240)
    .onAppear {
      vm.presentationAnchor = anchorProvider
    }
    .onChange(of: vm.state) { _, newValue in
      if case .signedIn = newValue { onDismiss() }
    }
  }

  // MARK: - Panel router

  @ViewBuilder
  private var panel: some View {
    switch vm.state {
    case .idle:                          idlePanel
    case .checkingBootstrap(let host):   spinnerPanel("Connecting to \(host.displayHost)…")
    case .needsOwnerClaim(let host):     ownerClaimPanel(host: host)
    case .registeringOwner(let host, _): spinnerPanel("Creating owner account at \(host.displayHost)…")
    case .needsAuth(let host):           needsAuthPanel(host: host)
    case .enteringSignInEmail(let host): signInEmailPanel(host: host)
    case .signingIn(let host, _):        spinnerPanel("Signing in to \(host.displayHost)…")
    case .enteringInviteDetails(let host): inviteDetailsPanel(host: host)
    case .registeringInvitee(let host, _, _): spinnerPanel("Joining \(host.displayHost)…")
    case .signedIn:                      spinnerPanel("Signed in.")
    case .error(let msg, _):             errorPanel(message: msg)
    }
  }

  // MARK: - Panels

  private var idlePanel: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Add a Maple Cloud server").font(.title3).bold()
      TextField("myserver.com", text: $vm.domainInput)
        .textFieldStyle(.roundedBorder)
        #if !os(macOS)
        .textInputAutocapitalization(.never)
        .keyboardType(.URL)
        #endif
        .onSubmit { Task { await vm.continueFromIdle() } }
      HStack {
        Spacer()
        Button("Cancel", action: onDismiss).keyboardShortcut(.cancelAction)
        Button("Continue") { Task { await vm.continueFromIdle() } }
          .keyboardShortcut(.defaultAction)
          .buttonStyle(.borderedProminent)
          .disabled(vm.domainInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
  }

  private func spinnerPanel(_ message: String) -> some View {
    VStack(spacing: 12) {
      ProgressView()
      Text(message).foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .center)
  }

  private func ownerClaimPanel(host: CloudHost) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Set up \(host.displayHost)").font(.title3).bold()
      Text("This server has no account yet. Enter your email — you'll be the owner.")
        .foregroundStyle(.secondary).font(.callout)
      TextField("you@example.com", text: $vm.emailInput)
        .textFieldStyle(.roundedBorder)
        #if !os(macOS)
        .textInputAutocapitalization(.never)
        .keyboardType(.emailAddress)
        #endif
      HStack {
        Spacer()
        Button("Cancel", action: onDismiss).keyboardShortcut(.cancelAction)
        Button { Task { await vm.claimOwner() } } label: {
          Label("Create owner account", systemImage: "key.fill")
        }
        .keyboardShortcut(.defaultAction)
        .buttonStyle(.borderedProminent)
        .disabled(vm.emailInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
  }

  private func needsAuthPanel(host: CloudHost) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Sign in to \(host.displayHost)").font(.title3).bold()
      Text("How would you like to continue?").foregroundStyle(.secondary).font(.callout)
      HStack {
        Button { vm.chooseSignIn() } label: {
          Label("Sign in", systemImage: "person.fill")
        }
        Button { vm.chooseJoinWithInvite() } label: {
          Label("Join with invite", systemImage: "envelope.fill")
        }
        Spacer()
        Button("Cancel", action: onDismiss).keyboardShortcut(.cancelAction)
      }
    }
  }

  private func signInEmailPanel(host: CloudHost) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Sign in to \(host.displayHost)").font(.title3).bold()
      TextField("you@example.com", text: $vm.emailInput)
        .textFieldStyle(.roundedBorder)
        #if !os(macOS)
        .textInputAutocapitalization(.never)
        .keyboardType(.emailAddress)
        #endif
      HStack {
        Spacer()
        Button("Cancel", action: onDismiss).keyboardShortcut(.cancelAction)
        Button { Task { await vm.signIn() } } label: {
          Label("Sign in with passkey", systemImage: "key.fill")
        }
        .keyboardShortcut(.defaultAction)
        .buttonStyle(.borderedProminent)
        .disabled(vm.emailInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
  }

  private func inviteDetailsPanel(host: CloudHost) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Join \(host.displayHost)").font(.title3).bold()
      TextField("Email", text: $vm.emailInput)
        .textFieldStyle(.roundedBorder)
        #if !os(macOS)
        .textInputAutocapitalization(.never)
        .keyboardType(.emailAddress)
        #endif
      TextField("Invite code", text: $vm.inviteInput)
        .textFieldStyle(.roundedBorder)
        .textCase(.uppercase)
      HStack {
        Spacer()
        Button("Cancel", action: onDismiss).keyboardShortcut(.cancelAction)
        Button { Task { await vm.joinWithInvite() } } label: {
          Label("Join with passkey", systemImage: "key.fill")
        }
        .keyboardShortcut(.defaultAction)
        .buttonStyle(.borderedProminent)
        .disabled(vm.emailInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                  || vm.inviteInput.trimmingCharacters(in: .whitespacesAndNewlines).count != 8)
      }
    }
  }

  private func errorPanel(message: String) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(message, systemImage: "exclamationmark.triangle.fill")
        .foregroundStyle(.red).font(.callout)
      HStack {
        Spacer()
        Button("Cancel", action: onDismiss).keyboardShortcut(.cancelAction)
        Button("Try again") { vm.retryFromError() }
          .keyboardShortcut(.defaultAction)
          .buttonStyle(.borderedProminent)
      }
    }
  }

  // MARK: - Anchor

  private func anchorProvider() -> ASPresentationAnchor {
    #if os(macOS)
    return NSApplication.shared.keyWindow ?? ASPresentationAnchor()
    #else
    return UIApplication.shared.connectedScenes
      .compactMap { ($0 as? UIWindowScene)?.keyWindow }
      .first ?? ASPresentationAnchor()
    #endif
  }
}
```

- [ ] **Step 2: Verify the project builds**

Run:
```bash
cd /Users/riabuz/Projects/_Maple/src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build 2>&1 | tail -30
```

Expected: BUILD SUCCEEDED (the new file is added to the Maple target by Xcode's auto-membership for new files in `Maple/Views/`; if the build fails with "no such module", open the project in Xcode once, drag the file in, save, and re-run).

- [ ] **Step 3: Commit**

```bash
git add src/apple/Maple/Views/AddMapleCloudSheet.swift
git commit -m "$(cat <<'EOF'
feat(maple-app): AddMapleCloudSheet view

SwiftUI sheet that drives AddMapleCloudViewModel. One panel per
state; zero business logic — the view model is the single source
of truth.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Replace `SelfHostedPickerSheet` in Settings (`MapleApp.swift`)

The Settings → Self Hosted tab is one of the two entry points. Replace the old sheet binding here.

**Files:**
- Modify: `src/apple/Maple/MapleApp.swift:225-233`

- [ ] **Step 1: Edit the sheet binding**

Locate `SelfHostedSettingsTab.body` in `src/apple/Maple/MapleApp.swift`. Change the `.sheet(isPresented: $showAddSheet)` block from:

```swift
        .sheet(isPresented: $showAddSheet) {
            SelfHostedPickerSheet(
                onConnect: { _, _ in
                    showAddSheet = false
                    Task { await refresh() }
                },
                onCancel: { showAddSheet = false }
            )
        }
```

To:

```swift
        .sheet(isPresented: $showAddSheet) {
            AddMapleCloudSheet(
                onDismiss: { showAddSheet = false },
                onSignedIn: { url, tokens, _ in
                    Task { @MainActor in
                        try? TokenStore.save(tokens, server: url)
                        try? await SelfHostedCredentialStore.shared
                            .setToken(tokens.access, forServerURL: url)
                        showAddSheet = false
                        await refresh()
                    }
                }
            )
        }
```

The `TokenStore.save` line keeps the passkey-backed `AuthSession` happy on next launch. The `SelfHostedCredentialStore.setToken` line keeps the existing sidebar list code unchanged for Phase 1 — it'll keep showing servers under "Self Hosted" until Phase 2 reorganizes the sidebar.

The closure's third parameter (the `AuthUser`) is unused in Phase 1 — discarded with `_`. Phase 2's new `CloudServerRegistry` will consume it.

- [ ] **Step 2: Verify the build**

Run:
```bash
cd /Users/riabuz/Projects/_Maple/src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build 2>&1 | tail -10
```

Expected: BUILD SUCCEEDED.

- [ ] **Step 3: Commit**

```bash
git add src/apple/Maple/MapleApp.swift
git commit -m "$(cat <<'EOF'
feat(maple-app): wire AddMapleCloudSheet into Settings

Replaces the broken SelfHostedPickerSheet binding in
SelfHostedSettingsTab. On signedIn we persist tokens to TokenStore
(for AuthSession bootstrap) and to SelfHostedCredentialStore
(so the existing sidebar Self Hosted section sees the new server).
The sidebar stays untouched until Phase 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Replace the three sheet bindings in `AppShell.swift`

`AppShell.swift` has three sheet presentations to migrate:

1. `showSelfHostedSheet` (line 142) — sidebar's "+ Self Hosted" button
2. `showJoinWithInviteSheet` (line 155) — "Have an invite?" branch from the old picker
3. `showSignInSheet` (line 168) — fallback when clicking a saved server with no credentials

The first two collapse into one new `showAddCloudSheet`. The third becomes another presentation of `AddMapleCloudSheet` with a pre-filled domain.

**Files:**
- Modify: `src/apple/Maple/Views/AppShell.swift`

- [ ] **Step 1: Update the state declarations**

Change lines 59-68 from:

```swift
    // Sheet state.
    @State private var showSMBSheet = false
    @State private var showSelfHostedSheet = false
    /// Self-Hosted "Join with invite" sheet — presented from the
    /// `SelfHostedPickerSheet`'s "Have an invite?" button.
    /// Plan 2026-04-28-passkey-auth Task B8.
    @State private var showJoinWithInviteSheet = false
    /// Sign-in sheet for the currently-selected Self-Hosted server, gated on
    /// `AuthSession.isSignedIn`. Presented automatically when the user picks
    /// a Self-Hosted row whose tokens haven't been restored.
    @State private var showSignInSheet = false
```

To:

```swift
    // Sheet state.
    @State private var showSMBSheet = false
    /// Single AddMapleCloudSheet entry point. `prefilledDomain` is empty
    /// when the user clicked "+" in the sidebar/Settings, or the host of
    /// the saved server they tapped without restored tokens.
    @State private var showAddCloudSheet = false
    @State private var addCloudPrefill: String = ""
```

- [ ] **Step 2: Remove the placeholder `AuthSession`**

The `placeholderJoinSession` property (lines 100-108) is no longer needed. Delete it:

```swift
    /// Throwaway `AuthSession` used as the environment value for the
    /// `JoinWithInviteView` sheet. The view doesn't read it (it builds its
    /// own per-URL session internally) but `@Environment(AuthSession.self)`
    /// requires *some* value to resolve. Using `about:blank` so it never
    /// collides with a real server URL.
    private var placeholderJoinSession: AuthSession {
        let url = URL(string: "about:blank")!
        return AuthSession(server: url, client: AuthClient(server: url))
    }
```

- [ ] **Step 3: Replace the three `.sheet` modifiers**

Find the block at lines 142-178 (the three `.sheet(isPresented: $showSelfHostedSheet)`, `$showJoinWithInviteSheet`, `$showSignInSheet` blocks). Replace them with:

```swift
        .sheet(isPresented: $showAddCloudSheet) {
            AddMapleCloudSheet(
                prefilledDomain: addCloudPrefill,
                onDismiss: { showAddCloudSheet = false },
                onSignedIn: { url, tokens, _ in
                    Task { @MainActor in
                        try? TokenStore.save(tokens, server: url)
                        try? await SelfHostedCredentialStore.shared
                            .setToken(tokens.access, forServerURL: url)
                        // Refresh the per-server AuthSession cache so the
                        // sidebar sees the user as signed in immediately.
                        let session = sessionFor(url)
                        await session.bootstrapAndRestore()
                        showAddCloudSheet = false
                        // Auto-load the newly-paired server.
                        connectSavedSelfHosted(url)
                    }
                }
            )
        }
```

- [ ] **Step 4: Update the sidebar "+" callback**

Find line 221 (`onAddSelfHosted: { showSelfHostedSheet = true }`). Change to:

```swift
                onAddSelfHosted: {
                    addCloudPrefill = ""
                    showAddCloudSheet = true
                },
```

- [ ] **Step 5: Update `connectSavedSelfHosted` fallback (line 749)**

Change `showSignInSheet = true` (line 749) to:

```swift
            // No credentials — open the AddMapleCloud sheet pre-filled with
            // this server's host so the user goes straight to sign-in.
            addCloudPrefill = url.host ?? url.absoluteString
            showAddCloudSheet = true
```

- [ ] **Step 6: Verify the build**

Run:
```bash
cd /Users/riabuz/Projects/_Maple/src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build 2>&1 | tail -20
```

Expected: BUILD SUCCEEDED. If you see errors about unused identifiers (`showSelfHostedSheet`, `showJoinWithInviteSheet`, `showSignInSheet`, `placeholderJoinSession`), the previous step missed a reference — grep them out and remove.

- [ ] **Step 7: Commit**

```bash
git add src/apple/Maple/Views/AppShell.swift
git commit -m "$(cat <<'EOF'
feat(maple-app): collapse three sheet bindings into AddMapleCloudSheet

Removes showSelfHostedSheet, showJoinWithInviteSheet,
showSignInSheet and placeholderJoinSession in favor of a single
showAddCloudSheet + addCloudPrefill pair driving
AddMapleCloudSheet. The sidebar "+" button and the
connectSavedSelfHosted fallback both go through the same flow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Delete the old sheets

Now that nothing references them, remove the dead code.

**Files:**
- Delete: `src/apple/Maple/Views/SignInView.swift`
- Delete: `src/apple/Maple/Views/JoinWithInviteView.swift`
- Modify: `src/apple/Maple/Views/AppShell.swift` (remove `SelfHostedPickerSheet` struct at the bottom)

- [ ] **Step 1: Confirm no remaining references**

Run:
```bash
cd /Users/riabuz/Projects/_Maple
grep -rn "SelfHostedPickerSheet\|SignInView\|JoinWithInviteView" src/apple/ \
  | grep -v "AppShell.swift\|SignInView.swift\|JoinWithInviteView.swift" \
  | grep -v "//\|#"
```

Expected: empty output (the only matches should be inside files we're about to delete or comments).

If there are real references (in `ManageUsersView.swift`, `QRScannerView.swift`, `MapleApp.swift`), they're stale comments — fix them up to reference `AddMapleCloudSheet` instead.

- [ ] **Step 2: Delete the two view files**

```bash
git rm src/apple/Maple/Views/SignInView.swift \
       src/apple/Maple/Views/JoinWithInviteView.swift
```

- [ ] **Step 3: Remove `SelfHostedPickerSheet` from `AppShell.swift`**

In `src/apple/Maple/Views/AppShell.swift`, delete the entire `// MARK: - Self-Hosted sheet` section starting at line 909 (the `struct SelfHostedPickerSheet: View` block, lines 909-948).

- [ ] **Step 4: Verify the build**

Run:
```bash
cd /Users/riabuz/Projects/_Maple/src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build 2>&1 | tail -20
```

Expected: BUILD SUCCEEDED.

- [ ] **Step 5: Run the package tests**

Run:
```bash
cd /Users/riabuz/Projects/_Maple/src/apple/Packages/MapleCore && swift test 2>&1 | tail -20
```

Expected: all tests pass (94+ existing + 16 new = ~110+).

- [ ] **Step 6: Commit**

```bash
git add -A src/apple/Maple/Views/
git commit -m "$(cat <<'EOF'
chore(maple-app): delete SignInView, JoinWithInviteView, SelfHostedPickerSheet

All three are subsumed by AddMapleCloudSheet. References cleaned up
in earlier commits in this phase.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Manual smoke test against `cloud.justmaple.app`

Required before merging — the unit tests prove the state machine but not that the WebAuthn ceremonies actually round-trip against a real server.

- [ ] **Step 1: Build and run**

Open `src/apple/Maple.xcodeproj` in Xcode, select the macOS scheme, and run.

- [ ] **Step 2: Test the sign-in path**

1. Open Settings → Self Hosted.
2. Click **Add Server…**.
3. Type `cloud.justmaple.app` (or your own claimed test server) into the domain field.
4. Click **Continue**.

Expected: Spinner appears briefly, then the "Sign in to cloud.justmaple.app" panel with two buttons.

5. Click **Sign in**.
6. Enter your registered email.
7. Click **Sign in with passkey**.

Expected: Touch ID / Face ID prompt; on success the sheet dismisses and the sidebar's Self Hosted section now contains the server.

- [ ] **Step 3: Test the invite path**

Have an admin generate an 8-char invite code for an unused email.

1. Settings → Self Hosted → Add Server.
2. Type the same domain → Continue.
3. Click **Join with invite**.
4. Enter the invited email + invite code.
5. Click **Join with passkey**.

Expected: Passkey ceremony, then sheet dismisses. The new server appears in the sidebar.

- [ ] **Step 4: Test the owner-claim path**

Spin up a fresh local API instance per `src/api/scripts/build-raw-ffi.sh` + `bun run dev` (no users in the DB).

1. Settings → Self Hosted → Add Server.
2. Type `localhost:3000` → Continue.

Expected: Bootstrap returns `claimed: false`, sheet shows "Set up localhost:3000 — This server has no account yet."

3. Enter `owner@example.com` → Create owner account.

Expected: Passkey ceremony, sheet dismisses, sidebar shows the new server.

- [ ] **Step 5: Test the error path**

1. Settings → Self Hosted → Add Server.
2. Type `not-a-real-domain.invalid` → Continue.

Expected: Spinner, then the error panel with a network error message and a **Try again** button. Click Try again → returns to the idle panel with the domain field still populated.

- [ ] **Step 6: Test the sidebar fallback**

(Only meaningful if the user has a saved server whose tokens were cleared.) Manually clear `TokenStore` for the test server (e.g. via `Keychain Access.app`) and click that server's row in the sidebar.

Expected: AddMapleCloudSheet opens with the server's host pre-filled.

- [ ] **Step 7: Capture a screen recording**

Record a 30-60s screen capture covering at least sign-in and one error. Attach to the PR.

---

## Task 14: PR + final checks

- [ ] **Step 1: Open PR**

```bash
git push -u origin HEAD
gh pr create --title "fix(apple): replace broken Self-Hosted connect sheet" --body "$(cat <<'EOF'
## Summary

- Replaces three sheets (`SelfHostedPickerSheet`, `SignInView`, `JoinWithInviteView`) with one `AddMapleCloudSheet` driven by an explicit state-machine view model.
- Fixes the "Settings → Connect to Maple Cloud → nothing happens" bug by giving every transition a visible UI state and every failure a visible error path.
- Drops the URL+bearer-token form. Users now type just a domain; the app routes to claim, sign-in, or invite-join based on `/api/auth/bootstrap`.
- This is **Phase 1** of the [Maple Cloud on Apple design](docs/superpowers/specs/2026-05-07-maple-cloud-on-apple-design.md). Sidebar restructure and Timeline view ship in Phases 2 and 3.

## Test plan

- [x] `swift test` in `src/apple/Packages/MapleCore` passes (16 new state-machine tests + 10 CloudHost tests + existing 94+).
- [x] `xcodebuild -scheme Maple -destination 'platform=macOS' build` succeeds.
- [x] Manual: sign-in on a claimed server (Touch ID).
- [x] Manual: invite-join on a claimed server.
- [x] Manual: owner-claim on a fresh server.
- [x] Manual: error path (invalid domain) → Try again returns to idle.
- [x] Manual: sidebar fallback (saved server, cleared tokens) opens sheet pre-filled.
- [x] Screen recording attached.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Confirm CI is green**

Run: `gh pr checks` (or wait for the GitHub Actions status to come through).

Expected: green.

---

## Self-review checklist (run before declaring done)

- [ ] Every state in `AddMapleCloudState` has an entry transition tested in `AddMapleCloudViewModelTests`.
- [ ] No references to `SelfHostedPickerSheet`, `SignInView`, `JoinWithInviteView` anywhere except in commit messages and design docs.
- [ ] The `onSignedIn` callback fires exactly once per successful flow (verified by Task 8's test).
- [ ] Error states recover to a sensible previous state (verified by Tasks 4-7's `recoverableTo` checks).
- [ ] No business logic in `AddMapleCloudSheet.swift` — every action calls a `vm.…` method.
- [ ] Build succeeds for both macOS and `iPhone 17 Pro` simulator.
- [ ] No test fixture changes — this is pure UI/auth work, not pipeline.
