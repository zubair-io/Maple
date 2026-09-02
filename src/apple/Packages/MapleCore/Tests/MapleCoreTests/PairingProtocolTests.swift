import CoreImage
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

  /// A v1-envelope-shaped payload (JSON + base64url) whose *inner* `v` field
  /// claims `2` is still not a real v2 code (real v2 is the binary + base32
  /// format from `qrStringV2()`, an entirely different envelope) — `parse`
  /// must reject it rather than trust the inner marker.
  func test_qrPayload_parse_rejectsV2VersionMarkerInsideV1Envelope() throws {
    let payload = PairingQRPayload(v: 2, ip: "10.0.0.1", port: 80, token: "t", tvPublicKey: Data([9]))
    let encoded = try payload.qrString()

    XCTAssertNil(PairingQRPayload.parse(encoded))
  }

  /// A genuinely unknown future version (3) inside a v1 envelope must also
  /// be rejected, same as today's v1-only gate was rejecting anything but 1.
  func test_qrPayload_parse_rejectsUnknownVersion() throws {
    let payload = PairingQRPayload(v: 3, ip: "10.0.0.1", port: 80, token: "t", tvPublicKey: Data([9]))
    let encoded = try payload.qrString()

    XCTAssertNil(PairingQRPayload.parse(encoded))
  }

  // MARK: 1b. PairingQRPayload v2 codec (#2137)

  func test_qrPayloadV2_qrStringV2_parse_roundTripsEveryField() throws {
    let payload = PairingQRPayload(
      v: 2,
      ip: "192.168.1.50",
      port: 8443,
      token: Data(repeating: 0xAB, count: 32).base64URLEncodedString(),
      tvPublicKey: Data(repeating: 0xCD, count: 32)
    )

    let encoded = try payload.qrStringV2()
    let parsed = try XCTUnwrap(PairingQRPayload.parse(encoded))

    XCTAssertEqual(parsed, payload)
    XCTAssertEqual(parsed.v, 2)
    XCTAssertEqual(parsed.ip, "192.168.1.50")
    XCTAssertEqual(parsed.port, 8443)
    XCTAssertEqual(parsed.token, Data(repeating: 0xAB, count: 32).base64URLEncodedString())
    XCTAssertEqual(parsed.tvPublicKey, Data(repeating: 0xCD, count: 32))
  }

  /// Edge-case IPv4 octets — 0 and 255 both round-trip through the raw byte
  /// packing without the string-parsing edge cases a naive implementation
  /// (e.g. treating a leading zero as invalid) might introduce.
  func test_qrPayloadV2_roundTrips_edgeIPOctets() throws {
    let payload = PairingQRPayload(
      v: 2,
      ip: "0.255.0.255",
      port: 1,
      token: Data(repeating: 0x11, count: 32).base64URLEncodedString(),
      tvPublicKey: Data(repeating: 0x22, count: 32)
    )

    let encoded = try payload.qrStringV2()
    let parsed = try XCTUnwrap(PairingQRPayload.parse(encoded))

    XCTAssertEqual(parsed.ip, "0.255.0.255")
    XCTAssertEqual(parsed.port, 1)
  }

  func test_qrPayloadV2_qrStringV2_throwsOnInvalidIP() {
    let payload = PairingQRPayload(
      v: 2,
      ip: "not-an-ip",
      port: 80,
      token: Data(repeating: 0xAB, count: 32).base64URLEncodedString(),
      tvPublicKey: Data(repeating: 0xCD, count: 32)
    )

    XCTAssertThrowsError(try payload.qrStringV2()) { error in
      XCTAssertEqual(error as? PairingPayloadV2EncodingError, .invalidIPv4Address)
    }
  }

  func test_qrPayloadV2_qrStringV2_throwsOnWrongKeyLength() {
    let payload = PairingQRPayload(
      v: 2,
      ip: "10.0.0.1",
      port: 80,
      token: Data(repeating: 0xAB, count: 32).base64URLEncodedString(),
      tvPublicKey: Data([0x01, 0x02])  // not 32 bytes
    )

    XCTAssertThrowsError(try payload.qrStringV2()) { error in
      XCTAssertEqual(error as? PairingPayloadV2EncodingError, .invalidPublicKeyLength)
    }
  }

  func test_qrPayloadV2_parse_rejectsGarbageAndTruncation() throws {
    XCTAssertNil(PairingQRPayload.parse("not valid base32 at all!!!"))

    let payload = PairingQRPayload(
      v: 2, ip: "10.0.0.1", port: 80,
      token: Data(repeating: 0xAB, count: 32).base64URLEncodedString(),
      tvPublicKey: Data(repeating: 0xCD, count: 32)
    )
    let encoded = try payload.qrStringV2()
    let truncated = String(encoded.prefix(encoded.count / 2))

    XCTAssertNil(PairingQRPayload.parse(truncated))
  }

  /// A phone that already accepts both versions must still pair with a TV
  /// that hasn't flipped to v2 yet — this is the whole point of the
  /// two-version window the sequencing note describes.
  func test_parse_acceptsBothV1AndV2() throws {
    let v1 = PairingQRPayload(v: 1, ip: "10.0.0.1", port: 80, token: "tok", tvPublicKey: Data([1, 2, 3]))
    let v2 = PairingQRPayload(
      v: 2, ip: "10.0.0.2", port: 81,
      token: Data(repeating: 0xEF, count: 32).base64URLEncodedString(),
      tvPublicKey: Data(repeating: 0x99, count: 32)
    )

    XCTAssertEqual(PairingQRPayload.parse(try v1.qrString()), v1)
    XCTAssertEqual(PairingQRPayload.parse(try v2.qrStringV2()), v2)
  }

  /// The actual deliverable: a real `TVPairingSession`'s v2 QR string
  /// renders to a meaningfully smaller symbol than the old v1 JSON +
  /// base64url string did, at the same error-correction level the TV uses.
  /// `CIQRCodeGenerator` outputs one pixel per module with no quiet zone, so
  /// the rendered image's pixel width *is* the module count.
  func test_qrPayloadV2_rendersSmallerQRSymbolThanV1() throws {
    let session = TVPairingSession(ip: "192.168.1.50", port: 54321)
    let v1Legacy = PairingQRPayload(
      v: 1, ip: "192.168.1.50", port: 54321,
      token: session.qrPayload.token, tvPublicKey: session.qrPayload.tvPublicKey
    )

    let v1String = try v1Legacy.qrString()
    let v2String = try session.qrPayload.qrStringV2()

    let v1Px = try XCTUnwrap(Self.qrSymbolPixelWidth(for: v1String))
    let v2Px = try XCTUnwrap(Self.qrSymbolPixelWidth(for: v2String))

    print("#2137: v1 QR is \(v1String.count) chars -> \(v1Px)x\(v1Px) px rendered; "
      + "v2 QR is \(v2String.count) chars -> \(v2Px)x\(v2Px) px rendered")

    XCTAssertLessThan(v2String.count, v1String.count)
    XCTAssertLessThan(v2Px, v1Px)
  }

  /// Renders `string` through the same `CIQRCodeGenerator` + level-M
  /// correction the TV's `QRCodeView` uses, and returns the rendered
  /// symbol's pixel width. The generator emits roughly one pixel per
  /// module, unscaled, so this tracks the module count closely — but it is
  /// an output-pixel measurement, not a spec module count.
  private static func qrSymbolPixelWidth(for string: String) throws -> Int? {
    let filter = try XCTUnwrap(CIFilter(name: "CIQRCodeGenerator"))
    filter.setValue(Data(string.utf8), forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    guard let output = filter.outputImage else { return nil }
    return Int(output.extent.width)
  }

  // MARK: 1c. Base32 (#2137)

  func test_base32_encode_decode_roundTripsArbitraryBytes() {
    let samples: [Data] = [
      Data(),
      Data([0x00]),
      Data([0xFF]),
      Data((0...70).map { UInt8($0 & 0xFF) }),
      Data(repeating: 0xAB, count: 71),
    ]
    for sample in samples {
      let encoded = Base32.encode(sample)
      XCTAssertEqual(Base32.decode(encoded), sample, "round-trip failed for \(sample.count) bytes")
    }
  }

  func test_base32_encode_usesOnlyUppercaseAlphabet() {
    let encoded = Base32.encode(Data((0...255).map { UInt8($0) }))
    XCTAssertTrue(encoded.allSatisfy { "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".contains($0) })
  }

  func test_base32_decode_rejectsLowercaseAndInvalidCharacters() {
    XCTAssertNil(Base32.decode("abcdefgh"))  // lowercase — a v1 base64url string will hit this
    XCTAssertNil(Base32.decode("AAAAAAA1"))  // '1' isn't in the RFC 4648 base32 alphabet
    XCTAssertNil(Base32.decode("AAAAAAA-"))  // base64url's separator, not base32's
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
    // #2137: TVPairingSession emits v2 (the compact binary + base32 QR
    // format) now that the phone-side parser accepts it.
    XCTAssertEqual(a.qrPayload.v, 2)
    XCTAssertEqual(b.qrPayload.v, 2)
  }
}
