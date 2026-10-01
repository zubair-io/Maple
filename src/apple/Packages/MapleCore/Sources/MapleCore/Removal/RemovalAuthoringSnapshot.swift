import Foundation

/// Includes foreign XML and culling, not just the removal field. A proposal
/// cannot silently replace an external edit made while inference was running.
public enum RemovalSidecarRevision: Equatable, Sendable {
  case missing
  case content(String)

  init(xml: String?) throws {
    self = try xml.map { .content(try RemovalBridge.digest(Data($0.utf8))) } ?? .missing
  }
}

public struct RemovalAuthoringSnapshot: Sendable {
  public let model: AdjustmentModel
  public let editRevision: UInt64
  public let sidecarRevision: RemovalSidecarRevision
}

extension EditSession {
  /// Close queued scalar writes before capturing the immutable AI input.
  /// Recheck the session after both actor hops; a late capture is not usable.
  public func removalAuthoringSnapshot() async throws -> RemovalAuthoringSnapshot {
    guard !isSavingRemoval, let store = sidecarStore as? XMPSidecarStore else {
      throw RemovalError.invalid("Removal authoring requires a local photo folder")
    }
    let current = model
    let revision = editRevision
    await flushPendingSidecarWrite()
    guard model == current, editRevision == revision else { throw RemovalError.saveConflict }
    let sidecarRevision = try await store.removalRevision()
    guard model == current, editRevision == revision else { throw RemovalError.saveConflict }
    return RemovalAuthoringSnapshot(
      model: current, editRevision: revision, sidecarRevision: sidecarRevision)
  }
}
