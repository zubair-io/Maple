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
