// src/apple/Packages/MapleCore/Sources/MapleCloudKit/Pairing/PairingCrypto.swift
import CryptoKit
import Foundation

/// Seals a pairing grant to the TV's Curve25519 public key. The symmetric key
/// derives from X25519(ephemeralSender, tvPublic) through HKDF-SHA256 salted
/// with the pairing token — so decryption requires BOTH network capture of the
/// POST and physical sight of the TV screen (the QR carries the token).
///
/// Algorithm is normative and must match byte-for-byte between the phone
/// (sender, C2) and TV (receiver, `TVPairingSession`) — see Task C1 brief.
public enum PairingCrypto {
  static let hkdfInfo = Data("maple-tv-pairing-v1".utf8)

  public static func seal(
    _ grant: SealedPairingGrant,
    to tvPublicKey: Data,
    pairingToken: String
  ) throws -> (ciphertext: Data, senderPublicKey: Data) {
    let ephemeral = Curve25519.KeyAgreement.PrivateKey()
    let tvKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: tvPublicKey)
    let shared = try ephemeral.sharedSecretFromKeyAgreement(with: tvKey)
    let key = shared.hkdfDerivedSymmetricKey(
      using: SHA256.self,
      salt: Data(pairingToken.utf8),
      sharedInfo: hkdfInfo,
      outputByteCount: 32
    )
    let plaintext = try JSONEncoder().encode(grant)
    let box = try ChaChaPoly.seal(plaintext, using: key)
    return (box.combined, ephemeral.publicKey.rawRepresentation)
  }

  public static func open(
    ciphertext: Data,
    senderPublicKey: Data,
    privateKey: Curve25519.KeyAgreement.PrivateKey,
    pairingToken: String
  ) throws -> SealedPairingGrant {
    let sender = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: senderPublicKey)
    let shared = try privateKey.sharedSecretFromKeyAgreement(with: sender)
    let key = shared.hkdfDerivedSymmetricKey(
      using: SHA256.self,
      salt: Data(pairingToken.utf8),
      sharedInfo: hkdfInfo,
      outputByteCount: 32
    )
    let box = try ChaChaPoly.SealedBox(combined: ciphertext)
    let plaintext = try ChaChaPoly.open(box, using: key)
    return try JSONDecoder().decode(SealedPairingGrant.self, from: plaintext)
  }
}
