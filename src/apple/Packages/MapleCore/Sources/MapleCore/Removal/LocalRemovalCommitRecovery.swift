// Reconcile only this actor's exact attempted publication, never an external
// edit that happens to contain the same removal stack (#3940).
import Foundation

struct LocalRemovalCommitAttempt: Equatable {
  let model: AdjustmentModel
  let expected: String
  let records: String
  let revision: RemovalSidecarRevision?
}

struct LocalRemovalCommitRecovery {
  private struct Pending {
    let attempt: LocalRemovalCommitAttempt
    let xml: String
    let priorXML: String?
  }

  private var pending: Pending?

  mutating func begin(_ attempt: LocalRemovalCommitAttempt, xml: String, priorXML: String?) {
    pending = Pending(attempt: attempt, xml: xml, priorXML: priorXML)
  }

  mutating func clear() { pending = nil }

  /// Scalar/workflow writes cannot replace an uncertain removal's exact
  /// checkpoint. A failure before visibility leaves the original XML intact
  /// and requires no reconciliation before another ordinary write.
  mutating func requireOrdinaryWrite(xml: String?) throws {
    guard let pending else { return }
    guard sameXML(xml, pending.priorXML), !sameXML(xml, pending.xml) else {
      throw RemovalError.saveConflict
    }
    self.pending = nil
  }

  mutating func recover(
    _ attempt: LocalRemovalCommitAttempt?, xml: String?, rawURL: URL?, at destination: URL
  ) throws -> AdjustmentModel? {
    guard let pending else { return nil }
    guard sameXML(xml, pending.xml) else {
      try requireOrdinaryWrite(xml: xml)
      return nil
    }
    guard attempt == pending.attempt, let rawURL else { throw RemovalError.saveConflict }
    // Undo's empty target must still bind to the original accepted source.
    try RemovalBridge.verifySource(records: pending.attempt.expected, rawURL: rawURL)
    try RemovalBridge.verifySource(records: pending.attempt.records, rawURL: rawURL)
    try LocalRemovalAssetStore.synchronizeAssets(records: pending.attempt.records, rawURL: rawURL)
    try XMPSidecarFilePublication.confirmExisting(pending.xml, at: destination)
    let saved = try XMPParser.parse(pending.xml).0
    // The owning store clears this only after NSFileCoordinator also returns
    // success. A late coordination error must retain the same retry identity.
    return saved
  }

  private func sameXML(_ lhs: String?, _ rhs: String?) -> Bool {
    lhs.map { Data($0.utf8) } == rhs.map { Data($0.utf8) }
  }
}
