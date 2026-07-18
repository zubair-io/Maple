// AddMapleCloudViewModel.swift
//
// State machine for the AddMapleCloud sign-in flow. ASWebAuthenticationSession
// is used to host the auth ceremony in a Safari-controlled context — the
// view model's job is to hand the session a target URL and translate the
// callback URL's query parameters into a `signedIn` transition.
//
// The actual ASWebAuthenticationSession lives in ASWebAuthSessionDriver
// (in the Maple app target, since AuthenticationServices' presentation
// APIs depend on AppKit/UIKit). The view model receives results via the
// `bridgeReceived…` methods from that driver.

import Foundation
import Observation

@MainActor
@Observable
public final class AddMapleCloudViewModel {
  /// Current state. The sheet renders one panel per case.
  public internal(set) var state: AddMapleCloudState = .idle

  /// Bound to the domain text field on the idle panel.
  public var domainInput: String = ""

  /// Side-effect callback — invoked exactly once when the auth driver
  /// reports success. The sheet uses it to persist tokens and dismiss.
  public typealias OnSignedIn = @MainActor (URL, AuthTokens, AuthUser) -> Void

  private let onSignedIn: OnSignedIn

  /// One-shot cancel flag. Set by `cancel()` from the sheet's
  /// `.onDisappear`. When set, even a late `bridgeReceivedAuthSuccess`
  /// call doesn't fire `onSignedIn`. The view model is single-use
  /// (recreated per sheet presentation), so a one-shot flag is correct.
  private var cancelled: Bool = false

  public init(onSignedIn: @escaping OnSignedIn = { _, _, _ in }) {
    self.onSignedIn = onSignedIn
  }

  // MARK: - Transitions

  /// Idle → authenticating. Called when the user taps Continue.
  /// Returns the parsed `CloudHost` so the caller (the sheet view)
  /// can hand it to its ASWebAuthSessionDriver.
  @discardableResult
  public func continueFromIdle() -> CloudHost? {
    guard let host = CloudHost.parse(domainInput) else {
      state = .error(message: "Enter a domain like myserver.com",
                     recoverableTo: .idle)
      return nil
    }
    state = .authenticating(host)
    return host
  }

  /// Driver reported a non-cancellation failure (DNS, TLS, malformed
  /// callback URL).
  public func driverFailed(message: String) {
    if case .authenticating = state {
      state = .error(message: message, recoverableTo: .idle)
    }
  }

  /// Driver reported the user explicitly cancelled the auth UI. No
  /// error panel — return to idle so the user can adjust the domain
  /// or close the sheet.
  public func driverCancelled() {
    if case .authenticating = state {
      state = .idle
    }
  }

  /// Driver successfully parsed the callback URL. Transition to
  /// `.signedIn` and (unless cancelled) fire the persistence callback.
  public func driverReceivedAuthSuccess(tokens: AuthTokens, user: AuthUser) {
    guard case .authenticating(let host) = state else { return }
    state = .signedIn(host, tokens: tokens, user: user)
    if cancelled { return }
    onSignedIn(host.url, tokens, user)
  }

  /// Resets the error state back to its `recoverableTo` target.
  public func retryFromError() {
    if case .error(_, let target) = state { state = target }
  }

  /// Mark this flow as cancelled. Idempotent. A late
  /// `driverReceivedAuthSuccess` after the user dismissed the sheet
  /// does NOT trigger token persistence.
  public func cancel() {
    cancelled = true
  }

  // MARK: - Preview

  public enum PreviewState: Sendable {
    case idle
    case prefilled
    case authenticating
    case error
  }

  /// Sample `AddMapleCloudViewModel` for SwiftUI `#Preview` blocks.
  /// Mutates `state` and `domainInput` directly to stage the requested
  /// panel without driving the auth state machine. Issue #139.
  public static func preview(_ state: PreviewState = .idle) -> AddMapleCloudViewModel {
    let vm = AddMapleCloudViewModel()
    switch state {
    case .idle:
      break
    case .prefilled:
      vm.domainInput = "myserver.example.com"
    case .authenticating:
      vm.domainInput = "myserver.example.com"
      if let host = CloudHost.parse(vm.domainInput) {
        vm.state = .authenticating(host)
      }
    case .error:
      vm.state = .error(message: "Couldn't reach myserver.example.com.",
                        recoverableTo: .idle)
    }
    return vm
  }
}
