import Foundation

/// Observable presentation of the shared durable ledger. Closing a sheet or
/// navigating away does not cancel its task; Cancel is an explicit boundary.
@MainActor
@Observable
public final class BatchAdjustmentController {
  public private(set) var operations: [BatchAdjustmentSnapshot] = []
  public private(set) var activeID: UUID?
  public private(set) var progress: BatchTransferProgress?
  public private(set) var isCancelling = false
  public var error: String?
  @ObservationIgnored private let ledger: BatchAdjustmentTransfer
  @ObservationIgnored private var displayedScopeID: String?

  public init(ledger: BatchAdjustmentTransfer = .shared) { self.ledger = ledger }

  public func refresh(scopeID: String?) async {
    displayedScopeID = scopeID
    guard let scopeID else {
      operations = []
      return
    }
    do {
      let saved = try await ledger.operations(in: scopeID)
      guard displayedScopeID == scopeID else { return }
      operations = saved
    } catch { self.error = error.localizedDescription }
  }

  public func start(
    request: BatchAdjustmentRequest, targets: [BatchAdjustmentTarget],
    library: BatchAdjustmentLibrary
  ) async {
    do {
      let operation = try await ledger.create(
        scopeID: library.id, request: request, targets: targets)
      await run(operation: operation, library: library, retryFailed: false)
    } catch { self.error = error.localizedDescription }
  }

  public func run(
    operation: BatchAdjustmentOperation, library: BatchAdjustmentLibrary, retryFailed: Bool
  ) async {
    guard activeID == nil else {
      error = BatchAdjustmentError.operationRunning.localizedDescription
      return
    }
    activeID = operation.id
    progress = nil
    isCancelling = false
    error = nil
    defer {
      activeID = nil
      isCancelling = false
    }
    do {
      _ = try await ledger.run(
        operation.id, scopeID: library.id, retryFailed: retryFailed,
        prepare: { target, request in try await library.prepare(target: target, request: request) },
        apply: { target, patch in try await library.apply(target: target, patch: patch) },
        progress: { update in await MainActor.run { self.progress = update } })
    } catch { self.error = error.localizedDescription }
    await refresh(scopeID: displayedScopeID ?? library.id)
  }

  public func cancel(_ id: UUID) async {
    isCancelling = true
    do { try await ledger.cancel(id) } catch { self.error = error.localizedDescription }
    await refresh(scopeID: displayedScopeID)
    if activeID == nil { isCancelling = false }
  }

  public func dismiss(_ id: UUID) async {
    do { try await ledger.dismiss(id) } catch { self.error = error.localizedDescription }
    await refresh(scopeID: displayedScopeID)
  }
}
