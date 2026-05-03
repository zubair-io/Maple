// PasskeyCeremony.swift
//
// Drives ASAuthorizationPlatformPublicKeyCredentialProvider for both
// registration (attestation) and login (assertion). Returns plain
// `[String: Any]` JSON shapes that the Maple API expects:
//
// Registration result:
//   { id, rawId, type, response: { clientDataJSON, attestationObject, transports } }
//
// Assertion result:
//   { id, rawId, type, response: { authenticatorData, clientDataJSON, signature } }
//
// All binary fields are base64url-encoded (no padding).

import AuthenticationServices
import Foundation

enum PasskeyCeremony {
  /// Performs WebAuthn registration. `options` is the JSON-decoded
  /// PublicKeyCredentialCreationOptions returned from
  /// `POST /api/auth/register/options`.
  static func create(options: [String: Any],
                     anchor: ASPresentationAnchor) async throws -> [String: Any] {
    guard let challengeB64 = options["challenge"] as? String,
          let challenge = Data(base64URLEncoded: challengeB64),
          let rp = options["rp"] as? [String: Any],
          let rpID = rp["id"] as? String,
          let user = options["user"] as? [String: Any],
          let userIDB64 = user["id"] as? String,
          let userID = Data(base64URLEncoded: userIDB64),
          let userName = user["name"] as? String
    else {
      throw NSError(domain: "PasskeyCeremony", code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "Malformed registration options"])
    }

    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpID)
    let req = provider.createCredentialRegistrationRequest(challenge: challenge,
                                                           name: userName,
                                                           userID: userID)

    let cred = try await PasskeyDelegate.run(request: req, anchor: anchor)
    guard let reg = cred as? ASAuthorizationPlatformPublicKeyCredentialRegistration else {
      throw NSError(domain: "PasskeyCeremony", code: -2,
                    userInfo: [NSLocalizedDescriptionKey: "Unexpected credential type for registration"])
    }

    let response: [String: Any] = [
      "clientDataJSON": reg.rawClientDataJSON.base64URLEncodedString(),
      "attestationObject": reg.rawAttestationObject?.base64URLEncodedString() ?? "",
      "transports": ["internal"],
    ]
    return [
      "id": reg.credentialID.base64URLEncodedString(),
      "rawId": reg.credentialID.base64URLEncodedString(),
      "type": "public-key",
      "response": response,
    ]
  }

  /// Performs WebAuthn assertion. `options` is the JSON-decoded
  /// PublicKeyCredentialRequestOptions returned from
  /// `POST /api/auth/login/options`.
  static func assert(options: [String: Any],
                     anchor: ASPresentationAnchor) async throws -> [String: Any] {
    guard let challengeB64 = options["challenge"] as? String,
          let challenge = Data(base64URLEncoded: challengeB64),
          let rpID = options["rpId"] as? String
    else {
      throw NSError(domain: "PasskeyCeremony", code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "Malformed assertion options"])
    }

    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpID)
    let req = provider.createCredentialAssertionRequest(challenge: challenge)

    if let allowed = options["allowCredentials"] as? [[String: Any]] {
      req.allowedCredentials = allowed.compactMap { entry -> ASAuthorizationPlatformPublicKeyCredentialDescriptor? in
        guard let idB64 = entry["id"] as? String,
              let id = Data(base64URLEncoded: idB64) else { return nil }
        return ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: id)
      }
    }

    let cred = try await PasskeyDelegate.run(request: req, anchor: anchor)
    guard let asn = cred as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
      throw NSError(domain: "PasskeyCeremony", code: -2,
                    userInfo: [NSLocalizedDescriptionKey: "Unexpected credential type for assertion"])
    }

    let response: [String: Any] = [
      "authenticatorData": asn.rawAuthenticatorData.base64URLEncodedString(),
      "clientDataJSON": asn.rawClientDataJSON.base64URLEncodedString(),
      "signature": asn.signature.base64URLEncodedString(),
    ]
    return [
      "id": asn.credentialID.base64URLEncodedString(),
      "rawId": asn.credentialID.base64URLEncodedString(),
      "type": "public-key",
      "response": response,
    ]
  }
}
