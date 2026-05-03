// PasskeyDelegate.swift
//
// Async wrapper around `ASAuthorizationController.performRequests()`.
// Bridges the delegate-based callback API into a single
// `withCheckedThrowingContinuation` so callers can `await` a credential.
//
// Also hosts the `Data` / `String` base64url helpers used by the
// passkey ceremony JSON encoding.

import AuthenticationServices
import Foundation

final class PasskeyDelegate: NSObject,
                             ASAuthorizationControllerDelegate,
                             ASAuthorizationControllerPresentationContextProviding {
  private let anchor: ASPresentationAnchor
  private var cont: CheckedContinuation<ASAuthorizationCredential, Error>?
  // Retains the controller (and self via its delegate strong refs) for the
  // lifetime of the request. ASAuthorizationController holds delegate weakly,
  // so without an external strong reference the request fails silently.
  private var controller: ASAuthorizationController?

  init(anchor: ASPresentationAnchor) {
    self.anchor = anchor
  }

  static func run(request: ASAuthorizationRequest,
                  anchor: ASPresentationAnchor) async throws -> ASAuthorizationCredential {
    let delegate = PasskeyDelegate(anchor: anchor)
    return try await withCheckedThrowingContinuation { c in
      delegate.cont = c
      let ctrl = ASAuthorizationController(authorizationRequests: [request])
      ctrl.delegate = delegate
      ctrl.presentationContextProvider = delegate
      delegate.controller = ctrl
      ctrl.performRequests()
    }
  }

  // MARK: ASAuthorizationControllerPresentationContextProviding
  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    anchor
  }

  // MARK: ASAuthorizationControllerDelegate
  func authorizationController(controller: ASAuthorizationController,
                               didCompleteWithAuthorization authorization: ASAuthorization) {
    cont?.resume(returning: authorization.credential)
    cont = nil
    self.controller = nil
  }

  func authorizationController(controller: ASAuthorizationController,
                               didCompleteWithError error: Error) {
    cont?.resume(throwing: error)
    cont = nil
    self.controller = nil
  }
}

// MARK: - base64url helpers

extension Data {
  /// Decodes an unpadded (or padded) base64url string into bytes.
  init?(base64URLEncoded s: String) {
    var t = s.replacingOccurrences(of: "-", with: "+")
             .replacingOccurrences(of: "_", with: "/")
    while t.count % 4 != 0 { t.append("=") }
    self.init(base64Encoded: t)
  }

  /// Encodes bytes as unpadded base64url.
  func base64URLEncodedString() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

extension String {
  /// Pads a base64 string up to a multiple of 4 characters with `=`.
  func padded() -> String {
    var s = self
    while s.count % 4 != 0 { s.append("=") }
    return s
  }
}
