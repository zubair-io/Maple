// AddMapleCloudState.swift
//
// State enum for the AddMapleCloud webview-based sign-in flow.
// The web app's existing auth UI handles claim / sign-in / invite
// branching inside the WKWebView; the native side only tracks
// "haven't started", "loading", "succeeded", "errored".

import Foundation

public indirect enum AddMapleCloudState: Equatable, Sendable {
  /// Initial — user is typing the domain.
  case idle

  /// Webview is loading the server's sign-in URL. The web app's
  /// AuthService posts an `auth_success` message via WKWebkit's
  /// `maple` script handler when the user completes any auth flow.
  case loadingWebview(CloudHost)

  /// Terminal success state. The view dismisses on entry.
  case signedIn(CloudHost, tokens: AuthTokens, user: AuthUser)

  /// Inline error for the panel that triggered the failure. Tap
  /// "Try again" to land back at `recoverableTo`.
  case error(message: String, recoverableTo: AddMapleCloudState)

  public static func == (lhs: AddMapleCloudState, rhs: AddMapleCloudState) -> Bool {
    switch (lhs, rhs) {
    case (.idle, .idle): return true
    case (.loadingWebview(let a), .loadingWebview(let b)): return a == b
    case (.signedIn(let a, let ta, let ua), .signedIn(let b, let tb, let ub)):
      return a == b && ta == tb && ua == ub
    case (.error(let ma, let ra), .error(let mb, let rb)):
      return ma == mb && ra == rb
    default: return false
    }
  }
}
