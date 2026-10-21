#if os(iOS)
  import Foundation
  import MapleCore
  import XCTest
  @testable import Maple

  /// Exercises the production journal's pure replay policy without reading or writing Keychain.
  final class WatchPairingTests: XCTestCase {
    private let server = URL(string: "https://photos.example.test")!

    func testSerializedGrantResumesWithOriginalWatchTokensAfterPhoneRotation() throws {
      let grant = makeGrant()
      let record = WatchPairingPending.Record(id: grant.id, server: server, grant: grant)
      let serialized = try JSONEncoder().encode(record)
      let restored = try JSONDecoder().decode(WatchPairingPending.Record.self, from: serialized)
      let rotatedPhone = tokens(subject: "owner", refresh: "phone-rotated")

      let resumed = try restored.resume(id: grant.id, server: server, currentTokens: rotatedPhone)

      XCTAssertEqual(resumed.id, grant.id)
      XCTAssertEqual(resumed.server, server)
      XCTAssertEqual(resumed.tokens, grant.tokens)
      XCTAssertNotEqual(resumed.tokens.refresh, rotatedPhone.refresh)
    }

    func testGrantCannotResumeWithAnotherWatchRequestID() {
      let grant = makeGrant()
      let record = WatchPairingPending.Record(id: grant.id, server: server, grant: grant)
      XCTAssertThrowsError(
        try record.resume(id: UUID(), server: server, currentTokens: tokens())
      ) { error in
        XCTAssertEqual(error as? WatchPairingPending.PairingError, .anotherRequest)
      }
    }

    func testGrantCannotResumeOnAnotherServer() {
      let grant = makeGrant()
      let record = WatchPairingPending.Record(id: grant.id, server: server, grant: grant)
      XCTAssertThrowsError(
        try record.resume(
          id: grant.id, server: URL(string: "https://other.example.test")!, currentTokens: tokens())
      ) { error in
        XCTAssertEqual(error as? WatchPairingPending.PairingError, .anotherRequest)
      }
    }

    func testSerializedUncertainMintCannotBeResumedAsSuccessful() throws {
      let id = UUID()
      let intent = WatchPairingPending.Record(id: id, server: server, grant: nil)
      let restored = try JSONDecoder().decode(
        WatchPairingPending.Record.self, from: JSONEncoder().encode(intent))
      XCTAssertThrowsError(try restored.resume(id: id, server: server, currentTokens: tokens())) {
        error in
        XCTAssertEqual(error as? WatchPairingPending.PairingError, .uncertain)
      }
    }

    func testSignedOutPhoneCannotResumeGrant() {
      let grant = makeGrant()
      let record = WatchPairingPending.Record(id: grant.id, server: server, grant: grant)
      XCTAssertThrowsError(try record.resume(id: grant.id, server: server, currentTokens: nil)) {
        error in
        XCTAssertEqual(error as? WatchPairingPending.PairingError, .accountChanged)
      }
    }

    func testAnotherSignedInAccountCannotReceivePreviousOwnersGrant() {
      let grant = makeGrant()
      let record = WatchPairingPending.Record(id: grant.id, server: server, grant: grant)
      XCTAssertThrowsError(
        try record.resume(id: grant.id, server: server, currentTokens: tokens(subject: "other"))
      ) { error in
        XCTAssertEqual(error as? WatchPairingPending.PairingError, .accountChanged)
      }
    }

    func testAccountComparisonRejectsMalformedAndEmptySubjectsOnEitherSide() {
      let valid = makeGrant()
      let invalidPairs = [
        AuthTokens(access: "malformed", refresh: "unused"),
        AuthTokens(access: "e30.!!!!.signature", refresh: "unused"),
        AuthTokens(access: "e30.e30.signature", refresh: "unused"),
        tokens(subject: ""),
      ]
      for invalid in invalidPairs {
        XCTAssertFalse(WatchPairingPending.sameAccount(grant: valid, currentTokens: invalid))
        let invalidGrant = WatchPairingGrant(id: valid.id, server: server, tokens: invalid)
        XCTAssertFalse(
          WatchPairingPending.sameAccount(grant: invalidGrant, currentTokens: tokens()))
      }
    }

    func testBase64URLPayloadMatchesAccountWithUnicodeSubject() {
      let subject = "photographer-\u{10FFFF}"
      let grant = WatchPairingGrant(id: UUID(), server: server, tokens: tokens(subject: subject))
      XCTAssertTrue(
        WatchPairingPending.sameAccount(
          grant: grant, currentTokens: tokens(subject: subject, refresh: "new-phone-token")))
    }

    private func makeGrant() -> WatchPairingGrant {
      WatchPairingGrant(id: UUID(), server: server, tokens: tokens(refresh: "watch-credential"))
    }

    private func tokens(subject: String = "owner", refresh: String = "phone-credential")
      -> AuthTokens
    {
      // The production helper only compares already-stored JWT subjects; cryptographic
      // authentication remains the API's responsibility and is covered by route tests.
      let payload = try! JSONSerialization.data(withJSONObject: ["sub": subject, "exp": 1])
      let encoded = payload.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
      return AuthTokens(access: "e30.\(encoded).signature", refresh: refresh)
    }
  }
#endif
