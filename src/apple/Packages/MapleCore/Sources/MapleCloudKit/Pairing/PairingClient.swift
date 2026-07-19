// src/apple/Packages/MapleCore/Sources/MapleCloudKit/Pairing/PairingClient.swift
import Foundation

/// Clean, typed failure modes for `PairingClient.deliver` — the phone side
/// never lets a raw `CryptoKitError` or transport `URLError` escape as the
/// caller-visible failure; everything collapses into one of these cases so a
/// pairing UI can present a sane message without switching on foreign error
/// types.
public enum PairingDeliveryError: Error, Equatable {
  /// The TV rejected the sealed grant. The string is the TV's error body —
  /// one of `TVPairingSession.PairingError`'s case names (`"badToken"`,
  /// `"expired"`, `"alreadyUsed"`, `"undecryptable"`) — or an HTTP status
  /// fallback if the body wasn't the expected shape.
  case rejected(String)
  /// The TV's response wasn't a well-formed HTTP response we can interpret.
  case malformedResponse
  /// `payload.tvPublicKey` isn't a valid 32-byte Curve25519 public key — a
  /// QR scan produced garbage, or the payload was hand-edited. Carry-forward
  /// from the C1 review: `Curve25519.KeyAgreement.PublicKey(rawRepresentation:)`
  /// throws on a wrong-length key, and that must not escape `deliver` as a
  /// bare CryptoKit error.
  case invalidTVPublicKey
}

/// Phone-side delivery: seals the grant to the TV's public key (see
/// `PairingCrypto`) and POSTs it to the TV's loopback/LAN listener
/// (`TVPairingListener`, same file group) at the address the QR code
/// encoded.
public enum PairingClient {
  public static func deliver(
    grant: SealedPairingGrant,
    to payload: PairingQRPayload,
    urlSession: URLSession = .shared
  ) async throws {
    let sealed: (ciphertext: Data, senderPublicKey: Data)
    do {
      sealed = try PairingCrypto.seal(grant, to: payload.tvPublicKey, pairingToken: payload.token)
    } catch {
      throw PairingDeliveryError.invalidTVPublicKey
    }

    guard let url = URL(string: "http://\(payload.ip):\(payload.port)/pair") else {
      throw PairingDeliveryError.malformedResponse
    }

    var request = URLRequest(url: url, timeoutInterval: 10)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: [
      "token": payload.token,
      "senderPublicKey": sealed.senderPublicKey.base64EncodedString(),
      "ciphertext": sealed.ciphertext.base64EncodedString(),
    ])

    let (data, response) = try await urlSession.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw PairingDeliveryError.malformedResponse
    }
    guard http.statusCode == 200 else {
      let errorBody = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
      throw PairingDeliveryError.rejected(errorBody ?? "http_\(http.statusCode)")
    }
  }
}
