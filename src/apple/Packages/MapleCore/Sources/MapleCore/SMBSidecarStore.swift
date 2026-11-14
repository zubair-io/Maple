import Foundation

/// Full-XMP workflow persistence through the browse session's connected SMB client (#4065).
public actor SMBSidecarStore: WorkflowVariantSidecarStoreProtocol {
  private let source: SMBSource
  private let ref: ImageRef
  private let variantId: String
  private let renderSidecar = WorkflowRenderSidecar()
  /// The document the editor's model represents: the merge base of its next save (#5828).
  private var adoptedXML: String?
  private var stagedAdoption: StagedAdoption?
  private let reconciliationHub = SidecarReconciliationHub()
  private var cached: (AdjustmentModel, CullingState)?
  private var pendingTask: Task<Void, Never>?
  private var writeTail: Task<Void, Error>?
  private var pendingModel: AdjustmentModel?
  private var pendingCulling: CullingState?
  private var pendingEdits: [SMBModelPublication] = []
  private var subscribers: [UInt64: AsyncStream<Error>.Continuation] = [:]
  private var nextSubscriberID: UInt64 = 0
  static let debounceNanoseconds: UInt64 = 750_000_000
  static let debounceInterval: Duration = .nanoseconds(debounceNanoseconds)

  public init(source: SMBSource, ref: ImageRef) {
    self.source = source
    self.ref = ref
    self.variantId = WorkflowContract.primaryVariantID
  }
  private init(source: SMBSource, ref: ImageRef, variantId: String) {
    self.source = source
    self.ref = ref
    self.variantId = variantId
  }
  public func load() async throws -> (AdjustmentModel, CullingState) {
    try await loadIfPresent() ?? (.default, CullingState())
  }
  public func loadIfPresent() async throws -> (AdjustmentModel, CullingState)? {
    if pendingModel != nil, let cached { return cached }
    let xml = try await readWorkflowXML()
    adoptedXML = xml
    stagedAdoption = nil
    return try xml.map { try XMPParser.parse($0) }
  }
  public func update(model: AdjustmentModel, culling: CullingState) {
    pendingModel = model
    pendingCulling = culling
    cached = (model, culling)
    pendingTask?.cancel()
    pendingTask = Task { [weak self] in
      do {
        try await Task.sleep(nanoseconds: Self.debounceNanoseconds)
        await self?.writePending()
      } catch {}
    }
  }
  public func flush() async {
    let task = pendingTask
    pendingTask = nil
    task?.cancel()
    _ = await task?.result
    await writePending()
    _ = await writeTail?.result
  }
  public func errors() -> AsyncStream<Error> {
    let id = nextSubscriberID
    nextSubscriberID &+= 1
    let (stream, continuation) = AsyncStream<Error>.makeStream()
    subscribers[id] = continuation
    continuation.onTermination = { [weak self] _ in
      Task { await self?.removeSubscriber(id) }
    }
    return stream
  }
  private func removeSubscriber(_ id: UInt64) { subscribers.removeValue(forKey: id) }

  public func writeConfirmed(model: AdjustmentModel, culling: CullingState) async throws {
    let task = pendingTask
    pendingTask = nil
    task?.cancel()
    _ = await task?.result
    pendingModel = model
    pendingCulling = culling
    cached = (model, culling)
    try await settlePending()
  }
  public func commitSemantic(
    model: AdjustmentModel, culling: CullingState, action: String, label: String
  ) async throws {
    let edit = try SMBModelPublication(
      model: model, culling: culling, action: action, label: label)
    pendingEdits.append(edit)
    pendingTask?.cancel()
    pendingTask = nil
    pendingModel = model
    pendingCulling = culling
    cached = (model, culling)
    try await settlePending()
  }
  private func settlePending() async throws {
    pendingTask?.cancel()
    pendingTask = nil
    guard let model = pendingModel, let culling = pendingCulling else {
      _ = await writeTail?.result
      return
    }
    pendingModel = nil
    pendingCulling = nil
    if pendingEdits.last?.represents(model: model, culling: culling) != true {
      pendingEdits.append(try SMBModelPublication(model: model, culling: culling))
    }
    let edits = pendingEdits
    let previous = writeTail
    let task = Task {
      _ = await previous?.result
      try await self.send(edits: edits)
    }
    writeTail = task
    do { try await task.value } catch {
      if pendingModel == nil {
        pendingModel = cached?.0 ?? model
        pendingCulling = cached?.1 ?? culling
      }
      throw error
    }
  }
  private func send(edits: [SMBModelPublication]) async throws {
    for edit in edits {
      // A preceding queued task may already have acknowledged this publication.
      guard pendingEdits.contains(where: { $0.id == edit.id }) else { continue }
      let base = adoptedXML
      let xml = try await source.mutateWorkflowSidecar(for: ref, variantId: variantId) {
        try edit.output(current: $0, base: base, variantId: self.variantId)
      }
      pendingEdits.removeAll { $0.id == edit.id }
      observe(xml, publishedBy: edit)
      try renderSidecar.write(xml)
    }
  }

  /// A published document that is not the one `edit`'s model represents (a merge, or
  /// another client's later save recognized after a lost acknowledgement) is offered
  /// to the editor; until it confirms, later saves keep merging against the document
  /// its model represents, so the stale model never reverts the merge.
  private func observe(_ published: String, publishedBy edit: SMBModelPublication) {
    guard let represented = edit.representedDocument,
      (try? WorkflowSidecarCore.holdSameAdjustments(published, represented)) != true
    else {
      adoptedXML = published
      stagedAdoption = nil
      return
    }
    let document = ReconciledSidecar(xml: published, model: edit.model, culling: edit.culling)
    adoptedXML = represented
    stagedAdoption = StagedAdoption(published: published, document: document)
    reconciliationHub.publish(document)
  }
  private func writePending() async {
    do { try await settlePending() } catch {
      for subscriber in subscribers.values { subscriber.yield(error) }
    }
  }
  public func readWorkflowXML() async throws -> String? {
    try await enqueueWorkflow(nil)
  }
  public func publishWorkflow(_ command: WorkflowPublication) async throws -> String {
    guard let xml = try await enqueueWorkflow(command) else {
      throw WorkflowSidecarError(message: "The SMB server did not confirm the checkpoint.")
    }
    return xml
  }
  private func enqueueWorkflow(_ command: WorkflowPublication?) async throws -> String? {
    try await settlePending()
    let previous = writeTail
    let task = Task {
      _ = await previous?.result
      let xml: String?
      if let command {
        xml = try await self.source.mutateWorkflowSidecar(for: self.ref, variantId: self.variantId)
        {
          try command.output(current: $0, variantId: self.variantId)
        }
      } else {
        xml = try await self.source.readWorkflowSidecar(for: self.ref, variantId: self.variantId)
      }
      if command != nil {
        self.adoptedXML = xml
        self.stagedAdoption = nil
      }
      if let xml {
        if self.pendingModel == nil { self.cached = try XMPParser.parse(xml) }
        try self.renderSidecar.write(xml)
      }
      return xml
    }
    writeTail = Task { _ = try await task.value }
    return try await task.value
  }
  public func listWorkflowVariants() async throws -> [WorkflowVariantSidecar] {
    _ = try await readWorkflowXML()
    return try await source.listWorkflowSidecars(for: ref)
  }
  public func createWorkflowVariant(_ record: SidecarWorkflow, sourceVariantId: String) async throws
  {
    _ = try await readWorkflowXML()
    try await source.createWorkflowSidecar(
      for: ref, record: record, sourceVariantId: sourceVariantId)
  }
  public func bindWorkflowVariant(_ variantId: String) async throws -> WorkflowVariantBinding {
    _ = try await readWorkflowXML()
    _ = try WorkflowSidecarCore.variantFilename(primaryName: "photo.xmp", variantId: variantId)
    let selected = SMBSidecarStore(source: source, ref: ref, variantId: variantId)
    _ = try await selected.loadIfPresent()
    return WorkflowVariantBinding(writer: selected, sidecarURL: selected.renderSidecar.url)
  }
}

extension SMBSidecarStore: ReconcilingSidecarStoreProtocol {
  public func reconciliations() -> AsyncStream<ReconciledSidecar> {
    reconciliationHub.subscribe()
  }

  public func confirmAdoption(of xml: String) {
    guard let staged = stagedAdoption, staged.published == xml else { return }
    adoptedXML = xml
    stagedAdoption = nil
    if pendingModel == staged.document.model, pendingCulling == staged.document.culling {
      pendingTask?.cancel()
      pendingTask = nil
      pendingModel = nil
      pendingCulling = nil
    }
    if let adopted = try? XMPParser.parse(xml) { cached = adopted }
  }
}
