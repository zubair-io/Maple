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
  public internal(set) var state: AddMapleCloudState = .idle

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
  /// SwiftUI sets it from the key window. Annotated `@MainActor` because the
  /// production resolver touches `NSApplication.shared.keyWindow` /
  /// `UIWindowScene.keyWindow`, both main-actor-only.
  public var presentationAnchor: @MainActor () -> ASPresentationAnchor = {
    ASPresentationAnchor()
  }

  /// Device label for the WebAuthn `register` ceremony. Defaults to a
  /// platform-appropriate name; tests can override.
  public var deviceLabel: () -> String = AddMapleCloudViewModel.defaultDeviceLabel

  /// Side-effect callback — invoked exactly once when state transitions
  /// to `.signedIn`. The sheet uses it to persist tokens, register the
  /// server with the existing credential store, and dismiss itself.
  /// Tests can pass a closure that records calls.
  public typealias OnSignedIn = @MainActor (URL, AuthTokens, AuthUser) -> Void

  private let onSignedIn: OnSignedIn

  /// One-shot cancel flag. Set by `cancel()` (called from the sheet's
  /// `onDismiss`). When set, `transitionToSignedIn` does NOT fire the
  /// callback — even if the underlying passkey ceremony completed
  /// successfully. This prevents a server from silently being registered
  /// in the background after the user clicked Cancel and the sheet
  /// disappeared. The view model is single-use (recreated per sheet
  /// presentation), so a one-shot flag is correct.
  private var cancelled: Bool = false

  public init(makeFlow: @escaping (URL) -> any CloudAuthFlow = { AuthClient(server: $0) },
              onSignedIn: @escaping OnSignedIn = { _, _, _ in }) {
    self.makeFlow = makeFlow
    self.onSignedIn = onSignedIn
  }

  /// Mark this flow as cancelled. Idempotent. Subsequent successful
  /// transitions skip the `onSignedIn` callback. Call from the sheet's
  /// `onDismiss` so a Touch ID prompt that completes after the user has
  /// dismissed the sheet does not register a server.
  public func cancel() {
    cancelled = true
  }

  /// Centralized signedIn transition — fires the callback exactly once,
  /// and only if the flow has not been cancelled.
  private func transitionToSignedIn(_ host: CloudHost,
                                    response resp: AuthVerifyResponse) {
    let tokens = AuthTokens(access: resp.access_token, refresh: resp.refresh_token)
    state = .signedIn(host, tokens: tokens, user: resp.user)
    if cancelled { return }
    onSignedIn(host.url, tokens, resp.user)
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
      transitionToSignedIn(host, response: resp)
    } catch {
      state = .error(message: error.localizedDescription,
                     recoverableTo: .needsOwnerClaim(host))
    }
  }

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
      transitionToSignedIn(host, response: resp)
    } catch {
      state = .error(message: error.localizedDescription,
                     recoverableTo: .enteringSignInEmail(host))
    }
  }

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
      transitionToSignedIn(host, response: resp)
    } catch {
      state = .error(message: error.localizedDescription,
                     recoverableTo: .enteringInviteDetails(host))
    }
  }

  /// Resets the error state back to its `recoverableTo` target.
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
