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
