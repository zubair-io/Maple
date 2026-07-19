// src/apple/Packages/MapleCore/Sources/MapleCloudKit/Pairing/TVPairingSession.swift
import CryptoKit
import Foundation

/// TV-side pairing session: mints a Curve25519 keypair and a single-use token,
/// exposes them as a `PairingQRPayload` for the TV to render as a QR code, and
/// redeems exactly one `PairingCrypto`-sealed grant from a phone that scanned it.
///
/// One `TVPairingSession` == one QR code == one redemption window. The TV-side
/// listener (Task C2) constructs a fresh session per pairing attempt.
public final class TVPairingSession {
  public enum PairingError: Error, Equatable {
    case expired
    case alreadyUsed
    case badToken
    case undecryptable
  }

  private static let expiryInterval: TimeInterval = 5 * 60

  private let privateKey: Curve25519.KeyAgreement.PrivateKey
  private let token: String
  private let createdAt: Date
  private let now: () -> Date
  private var used = false

  public let qrPayload: PairingQRPayload

  public init(ip: String, port: UInt16, now: @escaping () -> Date = Date.init) {
    let privateKey = Curve25519.KeyAgreement.PrivateKey()
    let token = TVPairingSession.generateToken()
    self.privateKey = privateKey
    self.token = token
    self.now = now
    self.createdAt = now()
    self.qrPayload = PairingQRPayload(
      v: 1,
      ip: ip,
      port: port,
      token: token,
      tvPublicKey: privateKey.publicKey.rawRepresentation
    )
  }

  /// Decision order matters for the security invariants: token equality is
  /// checked first, in constant time, so a probe with a wrong token learns
  /// nothing about whether the session is expired or already used. Expiry and
  /// single-use are checked before attempting decryption so a garbled or
  /// hostile ciphertext never masks the real reason for rejection. The
  /// session is marked used ONLY after `PairingCrypto.open` actually
  /// succeeds, so a malformed request from an attacker who guessed the token
  /// shape can't burn the legitimate phone's redemption.
  public func redeem(
    ciphertext: Data,
    senderPublicKey: Data,
    token: String
  ) -> Result<SealedPairingGrant, PairingError> {
    guard TVPairingSession.constantTimeEquals(token, self.token) else {
      return .failure(.badToken)
    }
    guard now().timeIntervalSince(createdAt) <= TVPairingSession.expiryInterval else {
      return .failure(.expired)
    }
    guard !used else {
      return .failure(.alreadyUsed)
    }
    guard
      let grant = try? PairingCrypto.open(
        ciphertext: ciphertext,
        senderPublicKey: senderPublicKey,
        privateKey: privateKey,
        pairingToken: self.token
      )
    else {
      return .failure(.undecryptable)
    }
    used = true
    return .success(grant)
  }

  /// Hash-then-compare instead of `==` on the raw strings: `String.==` can
  /// short-circuit on the first mismatched byte, which leaks timing
  /// information about how much of a guessed token was correct. Hashing both
  /// sides first means the final `Digest.==` always compares full,
  /// fixed-length, unpredictable values.
  private static func constantTimeEquals(_ a: String, _ b: String) -> Bool {
    let hashA = SHA256.hash(data: Data(a.utf8))
    let hashB = SHA256.hash(data: Data(b.utf8))
    return hashA == hashB
  }

  /// 32 cryptographically random bytes, base64url-encoded — CryptoKit's
  /// `SymmetricKey` generation is backed by the platform CSPRNG, so this
  /// avoids a direct `Security` framework dependency for randomness.
  private static func generateToken() -> String {
    let key = SymmetricKey(size: .bits256)
    let bytes = key.withUnsafeBytes { Data($0) }
    return bytes.base64URLEncodedString()
  }
}
