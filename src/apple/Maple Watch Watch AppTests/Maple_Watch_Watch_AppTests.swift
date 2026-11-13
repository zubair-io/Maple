import Foundation
import MapleCloudKit
import Testing

struct WatchPairingContractTests {
  @Test func grantRoundTripsRequestIdentityAndDistinctCredentials() throws {
    let id = UUID()
    let grant = WatchPairingGrant(
      id: id, server: URL(string: "https://photos.example.com")!,
      tokens: AuthTokens(access: "watch-access", refresh: "watch-refresh"))
    let wire = try JSONEncoder().encode(WatchPairingReply(grant: grant))
    let reply = try JSONDecoder().decode(WatchPairingReply.self, from: wire)
    #expect(reply.grant?.id == id)
    #expect(reply.grant?.tokens == grant.tokens)
    #expect(reply.grant?.isValid == true)
    #expect(reply.error == nil)
  }

  @Test(arguments: [
    "file:///private/photo", "ftp://photos.example.com", "https://user:pass@photos.example.com",
  ])
  func rejectsUnsafeServerAddresses(address: String) {
    let grant = WatchPairingGrant(
      id: UUID(), server: URL(string: address)!,
      tokens: AuthTokens(access: "watch-access", refresh: "watch-refresh"))
    #expect(!grant.isValid)
  }

  @Test func rejectsEmptyCredentials() {
    let grant = WatchPairingGrant(
      id: UUID(), server: URL(string: "https://photos.example.com")!,
      tokens: AuthTokens(access: "", refresh: "watch-refresh"))
    #expect(!grant.isValid)
  }

  @Test func pairingAndAcknowledgementRetainSameRequestIdentity() throws {
    let id = UUID()
    for kind in ["pair", "ack"] {
      let wire = try JSONEncoder().encode(WatchPairingMessage(kind: kind, requestID: id))
      let decoded = try JSONDecoder().decode(WatchPairingMessage.self, from: wire)
      #expect(decoded.kind == kind)
      #expect(decoded.requestID == id)
    }
  }
}

struct WatchPairingReplyLifetimeTests {
  @Test func retryRejectsOlderReplyEvenWhenWireIdentityIsReused() {
    var attempt = WatchPairingAttempt()
    let id = UUID()
    attempt.begin(id: id)
    let firstGeneration = attempt.generation
    attempt.begin(id: id)
    #expect(!attempt.accepts(id: id, generation: firstGeneration))
    #expect(attempt.accepts(id: id, generation: attempt.generation))
  }

  @Test func disconnectRejectsInFlightGrantAndNewAttemptRejectsPreviousServerGrant() {
    var attempt = WatchPairingAttempt()
    let oldID = UUID()
    attempt.begin(id: oldID)
    let oldGeneration = attempt.generation
    attempt.cancel()
    #expect(!attempt.accepts(id: oldID, generation: oldGeneration))
    let newID = UUID()
    attempt.begin(id: newID)
    #expect(!attempt.accepts(id: oldID, generation: attempt.generation))
    #expect(attempt.accepts(id: newID, generation: attempt.generation))
  }
}
