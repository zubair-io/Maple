// AddMapleCloudState.swift
//
// State enum for the AddMapleCloud sign-in flow. The flow uses
// ASWebAuthenticationSession (a Safari-controlled context outside the
// host app's entitlement scope) so passkeys work for any customer's
// domain. The native sheet only owns the domain-entry panel and a
// progress / error / success view; the auth ceremony happens in the
// system-presented Safari context.

import Foundation

public indirect enum AddMapleCloudState: Equatable, Sendable {
  /// Initial — user is typing the domain.
  case idle

  /// ASWebAuthenticationSession is in flight.
  case authenticating(CloudHost)

  /// Terminal success state. The view dismisses on entry.
  case signedIn(CloudHost, tokens: AuthTokens, user: AuthUser)

  /// Inline error (non-cancellation failures only — explicit user
  /// cancellation routes back to .idle without an error panel).
  case error(message: String, recoverableTo: AddMapleCloudState)

  public static func == (lhs: AddMapleCloudState, rhs: AddMapleCloudState) -> Bool {
    switch (lhs, rhs) {
    case (.idle, .idle): return true
    case (.authenticating(let a), .authenticating(let b)): return a == b
    case (.signedIn(let a, let ta, let ua), .signedIn(let b, let tb, let ub)):
      return a == b && ta == tb && ua == ub
    case (.error(let ma, let ra), .error(let mb, let rb)):
      return ma == mb && ra == rb
    default: return false
    }
  }
}
