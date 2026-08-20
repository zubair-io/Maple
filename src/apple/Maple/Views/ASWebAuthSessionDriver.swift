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
// Token handoff (#856): we do NOT take tokens out of the redirect URL.
// Instead we run an OAuth-style PKCE code exchange. We generate a random
// `code_verifier`, send its S256 `code_challenge` + an opaque `state` on the
// initial URL:
//   <host>?native_callback=maple-app&code_challenge=…&state=…
// The web app, after the passkey ceremony, redirects a ONE-TIME CODE back:
//   maple-app://auth-success?code=…&state=…
// ASWebAuthenticationSession delivers that redirect privately to this session
// (never to other apps). We verify `state`, then redeem the code + verifier at
// `/api/auth/native-code/redeem` for freshly-minted, device-scoped tokens. A
// raw refresh token therefore never rides in a redirect URL.

import AuthenticationServices
import CryptoKit
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

  /// PKCE verifier + CSRF state for the in-flight session. Held between
  /// `start()` and the callback; cleared when the session completes.
  private var pkceVerifier: String?
  private var expectedState: String?
  private var host: CloudHost?

  /// Custom URL scheme the web app redirects the one-time code to. Unique to
  /// Maple. ASWebAuthenticationSession captures it internally — no Info.plist.
  static let callbackScheme = "maple-app"

  /// Path in the redirect URL: `maple-app://auth-success?...`
  static let callbackHost = "auth-success"

  /// Begin the auth flow against `host`. The completion handler runs on the
  /// main actor. Cancelling via `cancel()` invalidates the session.
  func start(host: CloudHost,
             completion: @escaping @MainActor (ASWebAuthSessionResult) -> Void) {
    let verifier = Self.randomURLSafe(byteCount: 32)
    let state = Self.randomURLSafe(byteCount: 16)
    self.pkceVerifier = verifier
    self.expectedState = state
    self.host = host

    guard var comps = URLComponents(url: host.url, resolvingAgainstBaseURL: false) else {
      completion(.failed("invalid host URL"))
      return
    }
    var items = comps.queryItems ?? []
    items.append(URLQueryItem(name: "native_callback", value: Self.callbackScheme))
    items.append(URLQueryItem(name: "code_challenge", value: Self.pkceChallenge(for: verifier)))
    items.append(URLQueryItem(name: "state", value: state))
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
        let result = await self.handleCallback(callbackURL: callbackURL, error: error)
        completion(result)
        self.session = nil
        self.pkceVerifier = nil
        self.expectedState = nil
        self.host = nil
      }
    }
    session.presentationContextProvider = self
    // Don't share Safari cookies — keeps the auth flow isolated and prevents
    // leaking the user's Maple Cloud session into Safari.
    session.prefersEphemeralWebBrowserSession = true
    self.session = session
    session.start()
  }

  /// Called by the view model when the user dismisses the parent sheet.
  func cancel() {
    session?.cancel()
    session = nil
    pkceVerifier = nil
    expectedState = nil
    host = nil
  }

  // MARK: - Callback handling

  private func handleCallback(callbackURL: URL?, error: Error?) async -> ASWebAuthSessionResult {
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
    guard let code = qp("code"), let returnedState = qp("state") else {
      return .failed("callback missing code/state")
    }
    // CSRF: the redirect's state must match the one we generated.
    guard let expected = expectedState, returnedState == expected else {
      return .failed("state mismatch")
    }
    guard let verifier = pkceVerifier, let host else {
      return .failed("missing PKCE verifier")
    }
    do {
      return try await Self.redeem(code: code, verifier: verifier, host: host)
    } catch {
      return .failed("code redemption failed: \(error.localizedDescription)")
    }
  }

  /// Exchange the one-time `code` + PKCE `verifier` for tokens.
  private static func redeem(code: String, verifier: String,
                             host: CloudHost) async throws -> ASWebAuthSessionResult {
    var req = URLRequest(url: host.url.appendingPathComponent("api/auth/native-code/redeem"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try JSONSerialization.data(
      withJSONObject: ["code": code, "code_verifier": verifier])
    let (data, resp) = try await URLSession.shared.data(for: req)
    guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
      let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
      return .failed("code redemption rejected (status \(status))")
    }
    struct Redeemed: Decodable {
      let access_token: String
      let refresh_token: String
      struct U: Decodable {
        let id: String
        let email: String
        let role: String
        // #2899 — absent on pre-upgrade servers; AuthUser applies the
        // granted-by-default rule.
        let file_access: Bool?
      }
      let user: U
    }
    let r = try JSONDecoder().decode(Redeemed.self, from: data)
    let tokens = AuthTokens(access: r.access_token, refresh: r.refresh_token)
    let user = AuthUser(
      id: r.user.id, email: r.user.email, role: r.user.role, file_access: r.user.file_access)
    return .success(tokens, user)
  }

  // MARK: - PKCE helpers

  /// `byteCount` cryptographically-random bytes, base64url (no padding).
  private static func randomURLSafe(byteCount: Int) -> String {
    SymmetricKey(size: .init(bitCount: byteCount * 8)).withUnsafeBytes { base64URL(Data($0)) }
  }

  /// PKCE S256: base64url(sha256(verifier)), matching the server's `pkceS256`.
  private static func pkceChallenge(for verifier: String) -> String {
    base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
  }

  private static func base64URL(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
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
    // The scene-less `UIWindow()` initializer is deprecated as of iOS 26 —
    // every anchor must be scene-bound. A window scene is guaranteed here:
    // the system only asks for a presentation anchor while the session is
    // being presented, which requires a foregrounded scene.
    let windowScenes = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
    if let keyWindow = windowScenes.compactMap(\.keyWindow).first {
      return keyWindow
    }
    guard let scene = windowScenes.first else {
      preconditionFailure("presentationAnchor requested with no connected window scene")
    }
    return scene.windows.first ?? ASPresentationAnchor(windowScene: scene)
    #endif
  }
}

#if os(macOS)
import AppKit
#else
import UIKit
#endif
