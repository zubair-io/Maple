import Foundation

/// Product snapshot/history state; values are loaded from the actual primary XMP (#4062).
@MainActor
@Observable
public final class EditorWorkflowState {
  public var isPresented = false
  public internal(set) var isBusy = false
  public internal(set) var errorText: String?
  public internal(set) var selectedVariantId = WorkflowContract.primaryVariantID
  public internal(set) var variants: [WorkflowVariantSidecar] = []
  @ObservationIgnored var selectedStore: (any WorkflowSidecarStoreProtocol)?
  @ObservationIgnored var pendingVariant: WorkflowVariantCreation?
  @ObservationIgnored let previews = WorkflowVariantPreviewCache()
  public private(set) var documentXmp: String?
  public private(set) var record: SidecarWorkflow?
  public private(set) var pendingRestoreLabel: String?
  var isApplying = false
  @ObservationIgnored var task: Task<Void, Never>?
  @ObservationIgnored var generation: UInt64 = 0
  @ObservationIgnored private var pending: WorkflowPublication?
  @ObservationIgnored private var beforeCheckpoint: String?
  @ObservationIgnored private var replay: (id: UInt64, undo: Bool, command: WorkflowPublication)?

  public init() {}

  public func isSupported(session: EditSession) -> Bool {
    session.sidecarStore is any WorkflowSidecarStoreProtocol
  }

  public func reload(session: EditSession) async {
    guard !isBusy else { return }
    session.endEdit()
    isBusy = true
    generation &+= 1
    let current = generation
    defer { if current == generation { isBusy = false } }
    do {
      await session.loadSidecar()
      guard session.hasLoadedSidecar else {
        throw session.sidecarError
          ?? failure("The photo's sidecar could not be loaded. Retry after reopening.")
      }
      await session.sidecarUpdateTask?.value
      let xml = try await store(session).readWorkflowXML()
      guard current == generation else { return }
      try adoptDocument(xml)
      if let variantsStore = session.primarySidecarStore as? any WorkflowVariantSidecarStoreProtocol
      {
        let listed = try await variantsStore.listWorkflowVariants()
        guard current == generation else { return }
        variants = listed
      }
      pending = nil
      pendingRestoreLabel = nil
      errorText = nil
    } catch {
      if current == generation { errorText = error.localizedDescription }
    }
  }

  public func saveSnapshot(name: String, session: EditSession) async {
    guard !isBusy else { return }
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      errorText = "Enter a snapshot name."
      return
    }
    session.endEdit()
    isBusy = true
    let current = generation
    defer { if current == generation { isBusy = false } }
    do {
      await session.sidecarUpdateTask?.value
      let writer = try store(session)
      let command: WorkflowPublication
      if let prior = pending, case .snapshot(_, _, let snapshot) = prior, snapshot.name == trimmed {
        command = prior
      } else {
        let xml = try await writer.readWorkflowXML()
        guard current == generation else { return }
        let initial = xml ?? XMPSerializer.serialize(model: session.model, culling: session.culling)
        let snapshot = WorkflowSnapshot(
          id: UUID().uuidString.lowercased(), name: trimmed, createdAtMs: timestamp(),
          adjustmentXmp: try WorkflowSidecarCore.checkpoint(xmp: initial))
        command = .snapshot(
          expectedXmp: xml, initialXmp: xml == nil ? initial : nil, snapshot: snapshot)
        pending = command
      }
      let published = try await writer.publishWorkflow(command)
      guard current == generation else { return }
      try adoptDocument(published)
      pending = nil
      errorText = nil
      session.sidecarError = nil
      session.announcer.announce("Saved snapshot \(trimmed)")
    } catch {
      if current == generation { errorText = error.localizedDescription }
    }
  }

  /// Freeze the selected real persisted checkpoint before displaying confirmation.
  public func prepareRestore(id: String, snapshot: Bool) {
    guard !isBusy, let xml = documentXmp else { return }
    do {
      let selected =
        snapshot
        ? record?.snapshots.first(where: { $0.id == id }).map { ($0.name, $0.adjustmentXmp) }
        : record?.history.first(where: { $0.id == id }).map { ($0.label, $0.adjustmentXmp) }
      guard let selected else {
        throw failure("This checkpoint is missing. Refresh and choose again.")
      }
      beforeCheckpoint = try WorkflowSidecarCore.checkpoint(xmp: xml)
      pendingRestoreLabel = selected.0
      pending = .restore(
        expectedXmp: xml,
        entry: WorkflowHistoryEntry(
          id: UUID().uuidString.lowercased(), createdAtMs: timestamp(),
          action: snapshot ? "snapshot-restore" : "history-restore",
          label: "Restore \(selected.0)", adjustmentXmp: selected.1))
      errorText = nil
    } catch { errorText = error.localizedDescription }
  }

  public func cancelRestore() {
    guard !isBusy else { return }
    pending = nil
    beforeCheckpoint = nil
    pendingRestoreLabel = nil
    errorText = nil
  }

  func clearBranchCommands() {
    pending = nil
    replay = nil
    beforeCheckpoint = nil
    pendingRestoreLabel = nil
  }

  public func confirmRestore(session: EditSession) async {
    guard !isBusy, case .restore(_, let entry) = pending, let command = pending,
      let before = beforeCheckpoint
    else { return }
    session.endEdit()
    isBusy = true
    let current = generation
    let editID = session.transactions.nextID
    let modelBefore = session.model
    let cullingBefore = session.culling
    defer { if current == generation { isBusy = false } }
    do {
      await session.sidecarUpdateTask?.value
      let published = try await store(session).publishWorkflow(command)
      guard current == generation else { return }
      let after = try WorkflowSidecarCore.checkpoint(xmp: published)
      if before != after {
        let restored = try await restoredState(published, session: session)
        guard current == generation, session.transactions.nextID == editID,
          session.model == modelBefore, session.culling == cullingBefore
        else {
          releaseRasters(restored.0)
          return
        }
        session.recordWorkflowRestore(
          before: before, after: after, restored: restored, label: entry.label)
      }
      try adoptDocument(published)
      pending = nil
      beforeCheckpoint = nil
      pendingRestoreLabel = nil
      errorText = nil
      session.sidecarError = nil
    } catch {
      if current == generation { errorText = error.localizedDescription }
    }
  }

  /// Session teardown invalidates UI publication; admitted writes may still finish.
  public func invalidate() {
    generation &+= 1
    isPresented = false
    pending = nil
    replay = nil
    beforeCheckpoint = nil
    pendingRestoreLabel = nil
    documentXmp = nil
    record = nil
    variants = []
    pendingVariant = nil
    previews.clear()
    errorText = nil
    isBusy = false
  }

  func beginReplay(session: EditSession, transaction: EditTransaction, undo: Bool) {
    guard !isBusy else { return }
    isBusy = true
    let current = generation
    task = Task {
      await self.replayCheckpoint(
        session: session, transaction: transaction, undo: undo, generation: current)
    }
  }

  private func replayCheckpoint(
    session: EditSession, transaction: EditTransaction, undo: Bool, generation current: UInt64
  ) async {
    defer { if current == generation { isBusy = false } }
    do {
      guard let checkpoint = transaction.checkpoint else { return }
      await session.sidecarUpdateTask?.value
      let writer = try store(session)
      let command: WorkflowPublication
      if let replay, replay.id == transaction.id, replay.undo == undo {
        command = replay.command
      } else {
        guard let xml = try await writer.readWorkflowXML() else {
          throw failure("The sidecar is missing. Restore it before editing.")
        }
        guard current == generation else { return }
        command = .replay(
          expectedXmp: xml,
          entry: WorkflowHistoryEntry(
            id: UUID().uuidString.lowercased(), createdAtMs: timestamp(),
            action: undo ? "undo" : "redo",
            label: "\(undo ? "Undo" : "Redo") \(transaction.description)",
            adjustmentXmp: undo ? checkpoint.before : checkpoint.after))
        replay = (transaction.id, undo, command)
      }
      let published = try await writer.publishWorkflow(command)
      guard current == generation else { return }
      let restored = try await restoredState(published, session: session)
      guard current == generation else {
        releaseRasters(restored.0)
        return
      }
      session.finishWorkflowReplay(transaction: transaction, undo: undo, restored: restored)
      try adoptDocument(published)
      replay = nil
      errorText = nil
      session.sidecarError = nil
    } catch {
      if current == generation { errorText = error.localizedDescription }
    }
  }

  func releaseRasters(_ model: AdjustmentModel) {
    Set(model.localAdjustments.flatMap(\.mask.registeredRasterIds)).forEach(MaskRasterRegistry.release)
  }

  func restoredState(_ xml: String, session: EditSession) async throws -> (
    AdjustmentModel, CullingState
  ) {
    let (model, culling) = try XMPParser.parse(xml)
    let resolved = try await ImportedWhiteBalanceResolver.resolve(
      asset: session.asset, model: model)
    return (await session.rehydratedMaskRasters(in: resolved), culling)
  }

  func adoptDocument(_ xml: String?) throws {
    let next = try xml.flatMap {
      try WorkflowSidecarCore.variantWorkflow(xmp: $0, variantId: selectedVariantId)
    }
    documentXmp = xml
    record = next
  }

  private func store(_ session: EditSession) throws -> any WorkflowSidecarStoreProtocol {
    guard let writer = session.sidecarStore as? any WorkflowSidecarStoreProtocol else {
      throw failure(
        "Snapshots and history are available for writable local folders, Photos, and server sources."
      )
    }
    return writer
  }

  private func timestamp() -> UInt64 { UInt64(Date().timeIntervalSince1970 * 1000) }
  private func failure(_ message: String) -> WorkflowSidecarError {
    WorkflowSidecarError(message: message)
  }
}
