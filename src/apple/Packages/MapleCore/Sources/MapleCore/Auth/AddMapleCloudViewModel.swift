// AddMapleCloudViewModel.swift
//
// State machine for the AddMapleCloud sheet. Webview-based sign-in (no
// native ASAuthorizationController) — the user types a domain and the
// sheet hosts a WKWebView pointed at that domain's auth page. The web
// app's existing sign-in / claim / invite UI handles every branch; the
// native side just captures the resulting tokens via a JS bridge.
//
// This intentionally has no `register`/`login`/`bootstrap` calls. The
// webview contains all the auth logic; we only know "in flight" vs
// "succeeded with tokens" vs "errored".

import Foundation
import Observation

@MainActor
@Observable
public final class AddMapleCloudViewModel {
  /// Current state. The sheet renders one panel per case.
  public internal(set) var state: AddMapleCloudState = .idle

  /// Bound to the domain text field on the idle panel.
  public var domainInput: String = ""

  /// Side-effect callback — invoked exactly once when the webview's
  /// JS bridge posts an `auth_success` message. The sheet uses it to
  /// persist tokens and dismiss.
  public typealias OnSignedIn = @MainActor (URL, AuthTokens, AuthUser) -> Void

  private let onSignedIn: OnSignedIn

  /// One-shot cancel flag. Set by `cancel()` from the sheet's
  /// `onDismiss` and `.onDisappear`. When set, even a late
  /// `bridgeReceivedAuthSuccess` call doesn't fire `onSignedIn`.
  /// The view model is single-use (recreated per sheet presentation),
  /// so a one-shot flag is correct.
  private var cancelled: Bool = false

  public init(onSignedIn: @escaping OnSignedIn = { _, _, _ in }) {
    self.onSignedIn = onSignedIn
  }

  // MARK: - Transitions

  /// Idle → loadingWebview. Called when the user taps Continue on the
  /// domain-entry panel.
  public func continueFromIdle() {
    guard let host = CloudHost.parse(domainInput) else {
      state = .error(message: "Enter a domain like myserver.com",
                     recoverableTo: .idle)
      return
    }
    state = .loadingWebview(host)
  }

  /// Webview reported a non-auth load failure (DNS, TLS, 5xx).
  public func webviewFailed(message: String) {
    guard case .loadingWebview(let host) = state else { return }
    state = .error(message: message, recoverableTo: .idle)
    _ = host
  }

  /// Webview's JS bridge posted an `auth_success` message. Validate
  /// the payload, persist tokens via the callback, transition to
  /// `.signedIn`. Suppressed if `cancel()` already fired.
  public func bridgeReceivedAuthSuccess(accessToken: String,
                                        refreshToken: String,
                                        user: AuthUser) {
    guard case .loadingWebview(let host) = state else { return }
    let tokens = AuthTokens(access: accessToken, refresh: refreshToken)
    state = .signedIn(host, tokens: tokens, user: user)
    if cancelled { return }
    onSignedIn(host.url, tokens, user)
  }

  /// Resets the error state back to its `recoverableTo` target.
  public func retryFromError() {
    if case .error(_, let target) = state { state = target }
  }

  /// Mark this flow as cancelled. Idempotent. A late `auth_success`
  /// from the webview after the user dismissed the sheet does NOT
  /// trigger token persistence.
  public func cancel() {
    cancelled = true
  }
}
