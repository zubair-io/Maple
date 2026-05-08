// ASWebAuthSessionDriver.swift
//
// Hosts an ASWebAuthenticationSession to drive sign-in for arbitrary
// Maple Cloud domains.
//
// Why this and not WKWebView? WKWebView's WebAuthn pipeline enforces
// the host app's Associated Domains entitlement (`webcredentials:<host>`),
// which means every customer's domain must be listed at app build
// time — broken for multi-tenant. ASWebAuthenticationSession runs the
// auth flow in a Safari-controlled context outside the host app's
// entitlement scope; passkeys work for any domain because Safari
// handles the ceremony, not the host app.
//
// The trade-off: tokens come back in a custom-URL-scheme redirect URL
// rather than a JS bridge. The web app's AuthService redirects to
//   maple-app://auth-success?access_token=…&refresh_token=…&user_id=…
//                            &user_email=…&user_role=…
// when the page is loaded with `?native_callback=maple-app` in the
// initial URL. ASWebAuthenticationSession sees the redirect URL,
// matches the callback scheme, and hands the URL to our completion
// handler — never showing the URL to other apps and never persisting
// it. The custom URL scheme does NOT need to be registered in
// Info.plist; ASWebAuthenticationSession captures it internally.

import AuthenticationServices
import Foundation
import MapleCore

/// Result of an ASWebAuth session.
enum ASWebAuthSessionResult {
  case success(AuthTokens, AuthUser)
  case cancelled
  case failed(String)
}

@MainActor
final class ASWebAuthSessionDriver: NSObject, ASWebAuthenticationPresentationContextProviding {
  private var session: ASWebAuthenticationSession?

  /// Custom URL scheme used by the web app to redirect tokens back to
  /// the native completion handler. Picked to be unique to Maple so
  /// it doesn't collide with anything else.
  static let callbackScheme = "maple-app"

  /// Path in the redirect URL: `maple-app://auth-success?...`
  static let callbackHost = "auth-success"

  /// Begin the auth flow against `host`. The completion handler runs
  /// on the main actor. Cancelling via `cancel()` invalidates the
  /// session; the completion fires with `.cancelled`.
  func start(host: CloudHost,
             completion: @escaping @MainActor (ASWebAuthSessionResult) -> Void) {
    // Build the URL the user lands on. The web app's AuthService reads
    // `native_callback` from the query string and redirects with the
    // matching scheme on auth success.
    guard var comps = URLComponents(url: host.url, resolvingAgainstBaseURL: false) else {
      completion(.failed("invalid host URL"))
      return
    }
    var items = comps.queryItems ?? []
    items.append(URLQueryItem(name: "native_callback", value: Self.callbackScheme))
    comps.queryItems = items
    guard let url = comps.url else {
      completion(.failed("invalid host URL"))
      return
    }

    let session = ASWebAuthenticationSession(
      url: url,
      callbackURLScheme: Self.callbackScheme
    ) { [weak self] callbackURL, error in
      Task { @MainActor in
        guard let self else { return }
        let result = Self.parseCallback(callbackURL: callbackURL, error: error)
        completion(result)
        self.session = nil
      }
    }
    session.presentationContextProvider = self
    // Don't share Safari cookies — keeps the auth flow isolated and
    // prevents leaking the user's Maple Cloud session into Safari.
    session.prefersEphemeralWebBrowserSession = true
    self.session = session
    session.start()
  }

  /// Called by the view model when the user dismisses the parent sheet.
  /// Tears down the in-flight session if any.
  func cancel() {
    session?.cancel()
    session = nil
  }

  // MARK: - Callback parsing

  private static func parseCallback(callbackURL: URL?, error: Error?) -> ASWebAuthSessionResult {
    if let error {
      let asError = error as NSError
      // ASWebAuthenticationSessionErrorDomain code 1 = canceledLogin
      if asError.domain == ASWebAuthenticationSessionErrorDomain,
         asError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
        return .cancelled
      }
      return .failed(error.localizedDescription)
    }
    guard let url = callbackURL,
          let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
    else {
      return .failed("missing callback URL")
    }
    let items = comps.queryItems ?? []
    func qp(_ name: String) -> String? {
      items.first(where: { $0.name == name })?.value
    }
    guard let access = qp("access_token"),
          let refresh = qp("refresh_token"),
          let userID = qp("user_id"),
          let email = qp("user_email"),
          let role = qp("user_role")
    else {
      return .failed("callback missing required query parameters")
    }
    let tokens = AuthTokens(access: access, refresh: refresh)
    let user = AuthUser(id: userID, email: email, role: role)
    return .success(tokens, user)
  }

  // MARK: - ASWebAuthenticationPresentationContextProviding

  nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    // Required to run on the main thread per Apple's docs. The system
    // calls this synchronously while we're already on main from .start().
    MainActor.assumeIsolated {
      Self.bestAnchor()
    }
  }

  @MainActor
  private static func bestAnchor() -> ASPresentationAnchor {
    #if os(macOS)
    return NSApplication.shared.keyWindow ?? ASPresentationAnchor()
    #else
    return UIApplication.shared.connectedScenes
      .compactMap { ($0 as? UIWindowScene)?.keyWindow }
      .first ?? ASPresentationAnchor()
    #endif
  }
}

#if os(macOS)
import AppKit
#else
import UIKit
#endif
