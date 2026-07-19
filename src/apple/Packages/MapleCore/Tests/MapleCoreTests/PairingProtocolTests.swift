import CryptoKit
import XCTest

@testable import MapleCloudKit

/// Milestone C, Task C1: the pairing protocol core (QR payload codec, sealed-grant
/// crypto, one-time TV session semantics). Phone and TV sides (C2+) must interoperate
/// byte-for-byte against this — see docs on `PairingCrypto` for the algorithm.
final class PairingProtocolTests: XCTestCase {
  private func sampleGrant(
    serverURL: String = "https://maple.local:8443",
    accessToken: String = "access-token-123",
    refreshToken: String = "refresh-token-456",
    deviceName: String = "Living Room TV"
  ) -> SealedPairingGrant {
    SealedPairingGrant(
      serverURL: URL(string: serverURL)!,
      accessToken: accessToken,
      refreshToken: refreshToken,
      deviceName: deviceName
    )
  }

  // MARK: 1. PairingQRPayload codec

  func test_qrPayload_qrString_parse_roundTripsEveryField() throws {
    let payload = PairingQRPayload(
      v: 1,
      ip: "192.168.1.50",
      port: 8443,
      token: "tok_abc123XYZ",
      tvPublicKey: Data([0x01, 0x02, 0x03, 0x04, 0xFF])
    )

    let encoded = try payload.qrString()
    let parsed = try XCTUnwrap(PairingQRPayload.parse(encoded))

    XCTAssertEqual(parsed, payload)
    XCTAssertEqual(parsed.v, 1)
    XCTAssertEqual(parsed.ip, "192.168.1.50")
    XCTAssertEqual(parsed.port, 8443)
    XCTAssertEqual(parsed.token, "tok_abc123XYZ")
    XCTAssertEqual(parsed.tvPublicKey, Data([0x01, 0x02, 0x03, 0x04, 0xFF]))
  }

  func test_qrPayload_parse_rejectsGarbage() {
    XCTAssertNil(PairingQRPayload.parse("this is not base64url json at all !!!"))
    XCTAssertNil(PairingQRPayload.parse(""))
  }

  func test_qrPayload_parse_rejectsTruncatedBase64() throws {
    let payload = PairingQRPayload(v: 1, ip: "10.0.0.1", port: 80, token: "t", tvPublicKey: Data([9, 9, 9]))
    let encoded = try payload.qrString()
    let truncated = String(encoded.prefix(encoded.count / 2))

    XCTAssertNil(PairingQRPayload.parse(truncated))
  }

  func test_qrPayload_parse_rejectsWrongVersion() throws {
    let payload = PairingQRPayload(v: 2, ip: "10.0.0.1", port: 80, token: "t", tvPublicKey: Data([9]))
    let encoded = try payload.qrString()

    XCTAssertNil(PairingQRPayload.parse(encoded))
  }

  // MARK: 2-5. PairingCrypto seal/open

  func test_sealOpen_roundTrip_returnsIdenticalGrant() throws {
    let tvKey = Curve25519.KeyAgreement.PrivateKey()
    let grant = sampleGrant()
    let token = "pairing-token-abc123"

    let (ciphertext, senderPublicKey) = try PairingCrypto.seal(
      grant, to: tvKey.publicKey.rawRepresentation, pairingToken: token)
    let opened = try PairingCrypto.open(
      ciphertext: ciphertext, senderPublicKey: senderPublicKey, privateKey: tvKey, pairingToken: token)

    XCTAssertEqual(opened, grant)
    XCTAssertEqual(opened.serverURL, URL(string: "https://maple.local:8443")!)
    XCTAssertEqual(opened.accessToken, "access-token-123")
    XCTAssertEqual(opened.refreshToken, "refresh-token-456")
    XCTAssertEqual(opened.deviceName, "Living Room TV")
  }

  func test_open_tamperedCiphertext_throws() throws {
    let tvKey = Curve25519.KeyAgreement.PrivateKey()
    let token = "pairing-token-abc123"
    let (ciphertext, senderPublicKey) = try PairingCrypto.seal(
      sampleGrant(), to: tvKey.publicKey.rawRepresentation, pairingToken: token)

    var tampered = ciphertext
    tampered[0] ^= 0xFF

    XCTAssertThrowsError(
      try PairingCrypto.open(
        ciphertext: tampered, senderPublicKey: senderPublicKey, privateKey: tvKey, pairingToken: token))
  }

  func test_open_wrongPairingToken_throws() throws {
    let tvKey = Curve25519.KeyAgreement.PrivateKey()
    let (ciphertext, senderPublicKey) = try PairingCrypto.seal(
      sampleGrant(), to: tvKey.publicKey.rawRepresentation, pairingToken: "right-token")

    XCTAssertThrowsError(
      try PairingCrypto.open(
        ciphertext: ciphertext, senderPublicKey: senderPublicKey, privateKey: tvKey,
        pairingToken: "wrong-token"))
  }

  func test_open_differentTVPrivateKey_throws() throws {
    let tvKey = Curve25519.KeyAgreement.PrivateKey()
    let otherKey = Curve25519.KeyAgreement.PrivateKey()
    let token = "pairing-token-abc123"
    let (ciphertext, senderPublicKey) = try PairingCrypto.seal(
      sampleGrant(), to: tvKey.publicKey.rawRepresentation, pairingToken: token)

    XCTAssertThrowsError(
      try PairingCrypto.open(
        ciphertext: ciphertext, senderPublicKey: senderPublicKey, privateKey: otherKey, pairingToken: token))
  }

  // MARK: 6-9. TVPairingSession

  func test_redeem_succeedsOnce_thenAlreadyUsedOnReplay() throws {
    let session = TVPairingSession(ip: "192.168.1.20", port: 5443)
    let grant = sampleGrant()
    let (ciphertext, senderPublicKey) = try PairingCrypto.seal(
      grant, to: session.qrPayload.tvPublicKey, pairingToken: session.qrPayload.token)

    let first = session.redeem(
      ciphertext: ciphertext, senderPublicKey: senderPublicKey, token: session.qrPayload.token)
    switch first {
    case .success(let redeemed): XCTAssertEqual(redeemed, grant)
    case .failure(let error): XCTFail("expected success on first redeem, got \(error)")
    }

    let second = session.redeem(
      ciphertext: ciphertext, senderPublicKey: senderPublicKey, token: session.qrPayload.token)
    XCTAssertEqual(second, .failure(.alreadyUsed))
  }

  func test_redeem_wrongToken_returnsBadToken_andDoesNotConsumeSession() throws {
    let session = TVPairingSession(ip: "10.0.0.5", port: 9000)
    let grant = sampleGrant()
    let (ciphertext, senderPublicKey) = try PairingCrypto.seal(
      grant, to: session.qrPayload.tvPublicKey, pairingToken: session.qrPayload.token)

    let badAttempt = session.redeem(
      ciphertext: ciphertext, senderPublicKey: senderPublicKey, token: "totally-wrong-token")
    XCTAssertEqual(badAttempt, .failure(.badToken))

    let goodAttempt = session.redeem(
      ciphertext: ciphertext, senderPublicKey: senderPublicKey, token: session.qrPayload.token)
    switch goodAttempt {
    case .success(let redeemed): XCTAssertEqual(redeemed, grant)
    case .failure(let error): XCTFail("expected success after the correct token, got \(error)")
    }
  }

  func test_redeem_pastFiveMinuteExpiry_returnsExpired() throws {
    var current = Date(timeIntervalSince1970: 1_700_000_000)
    let session = TVPairingSession(ip: "10.0.0.5", port: 9000, now: { current })
    let (ciphertext, senderPublicKey) = try PairingCrypto.seal(
      sampleGrant(), to: session.qrPayload.tvPublicKey, pairingToken: session.qrPayload.token)

    current = current.addingTimeInterval(5 * 60 + 1)

    let result = session.redeem(
      ciphertext: ciphertext, senderPublicKey: senderPublicKey, token: session.qrPayload.token)
    XCTAssertEqual(result, .failure(.expired))
  }

  func test_redeem_justUnderFiveMinutes_stillSucceeds() throws {
    var current = Date(timeIntervalSince1970: 1_700_000_000)
    let session = TVPairingSession(ip: "10.0.0.5", port: 9000, now: { current })
    let grant = sampleGrant()
    let (ciphertext, senderPublicKey) = try PairingCrypto.seal(
      grant, to: session.qrPayload.tvPublicKey, pairingToken: session.qrPayload.token)

    current = current.addingTimeInterval(5 * 60 - 1)

    let result = session.redeem(
      ciphertext: ciphertext, senderPublicKey: senderPublicKey, token: session.qrPayload.token)
    switch result {
    case .success(let redeemed): XCTAssertEqual(redeemed, grant)
    case .failure(let error): XCTFail("expected success just under 5 minutes, got \(error)")
    }
  }

  func test_twoSessions_haveDistinctTokensAndKeys() {
    let a = TVPairingSession(ip: "10.0.0.1", port: 1000)
    let b = TVPairingSession(ip: "10.0.0.1", port: 1000)

    XCTAssertNotEqual(a.qrPayload.token, b.qrPayload.token)
    XCTAssertNotEqual(a.qrPayload.tvPublicKey, b.qrPayload.tvPublicKey)
    XCTAssertEqual(a.qrPayload.v, 1)
    XCTAssertEqual(b.qrPayload.v, 1)
  }
}
