import Foundation

/// Full-XMP workflow persistence through the browse session's connected SMB client (#4065).
public actor SMBSidecarStore: WorkflowVariantSidecarStoreProtocol {
  private let source: SMBSource
  private let ref: ImageRef
  private let variantId: String
  private let renderSidecar = WorkflowRenderSidecar()
  private var cached: (AdjustmentModel, CullingState)?
  private var pendingTask: Task<Void, Never>?
  private var writeTail: Task<Void, Error>?
  private var pendingModel: AdjustmentModel?
  private var pendingCulling: CullingState?
  private var pendingEdits: [SMBSemanticPublication] = []
  private var subscribers: [UInt64: AsyncStream<Error>.Continuation] = [:]
  private var nextSubscriberID: UInt64 = 0
  static let debounceInterval: Duration = .milliseconds(750)

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
    guard let xml = try await readWorkflowXML() else { return nil }
    return try XMPParser.parse(xml)
  }
  public func update(model: AdjustmentModel, culling: CullingState) {
    pendingModel = model
    pendingCulling = culling
    cached = (model, culling)
    pendingTask?.cancel()
    pendingTask = Task { [weak self] in
      do {
        try await Task.sleep(for: Self.debounceInterval)
        await self?.writePending()
      } catch {}
    }
  }
  public func flush() async {
    pendingTask?.cancel()
    pendingTask = nil
    await writePending()
    _ = await writeTail?.result
  }
  public func errors() -> AsyncStream<Error> {
    let id = nextSubscriberID
    nextSubscriberID &+= 1
    return AsyncStream { continuation in
      subscribers[id] = continuation
      continuation.onTermination = { [weak self] _ in
        Task { await self?.removeSubscriber(id) }
      }
    }
  }
  private func removeSubscriber(_ id: UInt64) { subscribers.removeValue(forKey: id) }

  public func writeConfirmed(model: AdjustmentModel, culling: CullingState) async throws {
    pendingTask?.cancel()
    pendingTask = nil
    pendingModel = model
    pendingCulling = culling
    cached = (model, culling)
    try await settlePending()
  }
  public func commitSemantic(
    model: AdjustmentModel, culling: CullingState, action: String, label: String
  ) async throws {
    let edit = try SMBSemanticPublication(
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
    let edits = pendingEdits
    let previous = writeTail
    let task = Task {
      _ = await previous?.result
      try await self.send(model: model, culling: culling, edits: edits)
    }
    writeTail = task
    do { try await task.value } catch {
      if pendingModel == nil {
        pendingModel = model
        pendingCulling = culling
      }
      throw error
    }
  }
  private func send(
    model: AdjustmentModel, culling: CullingState, edits: [SMBSemanticPublication]
  ) async throws {
    for edit in edits {
      let xml = try await source.mutateWorkflowSidecar(for: ref, variantId: variantId) {
        try edit.output(current: $0, variantId: self.variantId)
      }
      pendingEdits.removeAll { $0.id == edit.id }
      try renderSidecar.write(xml)
    }
    // An acknowledged semantic action already includes the model and culling.
    // Rewriting that frozen model would erase a later client's accepted edit.
    if edits.last?.represents(model: model, culling: culling) == true { return }
    let xml = try await source.mutateWorkflowSidecar(for: ref, variantId: variantId) { current in
      XMPSerializer.serialize(
        model: model, culling: culling,
        metadata: current.map { XMPParser.parseMetadata($0) } ?? XmpMetadata(),
        passthrough: current.map { XMPParser.parsePassthrough($0) } ?? .empty)
    }
    try renderSidecar.write(xml)
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
    _ = try await selected.readWorkflowXML()
    return WorkflowVariantBinding(writer: selected, sidecarURL: selected.renderSidecar.url)
  }
}
