import Foundation

/// Full-XMP workflow persistence through the browse session's connected SMB client (#4065).
public actor SMBSidecarStore: WorkflowVariantSidecarStoreProtocol {
  private let source: SMBSource
  private let ref: ImageRef
  private let variantId: String
  private let renderSidecar = WorkflowRenderSidecar()
  private var adoptedXML: String?
  private var cached: (AdjustmentModel, CullingState)?
  private var pendingTask: Task<Void, Never>?
  private var writeTail: Task<Void, Error>?
  private var pendingModel: AdjustmentModel?
  private var pendingCulling: CullingState?
  private var pendingEdits: [SMBModelPublication] = []
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
    let xml = try await readWorkflowXML()
    adoptedXML = xml
    return try xml.map { try XMPParser.parse($0) }
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
    let (stream, continuation) = AsyncStream<Error>.makeStream()
    subscribers[id] = continuation
    continuation.onTermination = { [weak self] _ in
      Task { await self?.removeSubscriber(id) }
    }
    return stream
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
      let expected = adoptedXML
      let xml = try await source.mutateWorkflowSidecar(for: ref, variantId: variantId) {
        try edit.output(current: $0, expected: expected, variantId: self.variantId)
      }
      // The server can return a newer document when recognizing a lost reply.
      // That document was not the model adopted by this editor: subsequent stale
      // edits must still fail rather than silently replacing the other client.
      adoptedXML = edit.publishedDocument
      pendingEdits.removeAll { $0.id == edit.id }
      try renderSidecar.write(xml)
    }
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
      if command != nil { self.adoptedXML = xml }
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
