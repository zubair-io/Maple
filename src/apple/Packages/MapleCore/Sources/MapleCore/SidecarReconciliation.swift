// A sidecar publication that merged an outside edit the live editor does not hold yet (#4983).
import Foundation

/// The merged document a store published, with the model and culling the editor
/// saved that produced it. The editor adopts `xml` and confirms it back to the
/// store; until then the store keeps merging later saves against the document
/// the editor's model still represents, so a stale model never reverts the merge.
public struct ReconciledSidecar: Equatable, Sendable {
  public let xml: String
  public let model: AdjustmentModel
  public let culling: CullingState
}

/// Stores that merge a stale save onto the current document instead of refusing it.
public protocol ReconcilingSidecarStoreProtocol: SidecarStoreProtocol {
  func reconciliations() async -> AsyncStream<ReconciledSidecar>
  /// The editor now shows `xml`: later saves are based on it.
  func confirmAdoption(of xml: String) async
}

/// Fan-out of reconciled publications, owned by the publishing actor.
final class SidecarReconciliationHub: @unchecked Sendable {
  private let lock = NSLock()
  private var subscribers: [UInt64: AsyncStream<ReconciledSidecar>.Continuation] = [:]
  private var nextID: UInt64 = 0

  func subscribe() -> AsyncStream<ReconciledSidecar> {
    AsyncStream { continuation in
      let id = register(continuation)
      continuation.onTermination = { [weak self] _ in self?.remove(id) }
    }
  }

  private func register(_ continuation: AsyncStream<ReconciledSidecar>.Continuation) -> UInt64 {
    lock.withLock {
      let id = nextID
      nextID &+= 1
      subscribers[id] = continuation
      return id
    }
  }

  private func remove(_ id: UInt64) {
    lock.withLock { _ = subscribers.removeValue(forKey: id) }
  }

  var hasSubscribers: Bool { lock.withLock { !subscribers.isEmpty } }

  func publish(_ document: ReconciledSidecar) {
    let current = lock.withLock { Array(subscribers.values) }
    for continuation in current { continuation.yield(document) }
  }
}

/// A merge published for the editor to adopt, and the document its model
/// still represents until it does.
struct PendingAdoption: Equatable, Sendable {
  let represented: String
  let document: ReconciledSidecar
}

/// The merge a store has published and is waiting for the editor to confirm.
struct StagedAdoption: Equatable, Sendable {
  let published: String
  let document: ReconciledSidecar
}
