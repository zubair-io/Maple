// XMPSidecarStore+Workflow.swift — semantic history, workflow publication and
// reconciliation of a stale save onto the current sidecar (#4983).

import Foundation

extension XMPSidecarStore {
  /// Record a real editor boundary, never an individual preview tick. Failed
  /// publication keeps this exact checkpoint for the next write/exit flush.
  public func commitSemantic(
    model: AdjustmentModel, culling: CullingState, action: String, label: String
  ) throws {
    try coordinateSidecarWrite(reconciling: true) { destination, existing in
      if let existing { try self.requireVariantWorkflow(in: existing) }
      let checkpoint = try WorkflowSidecarCore.checkpoint(
        xmp: self.serializedSidecar(model: model, culling: culling, existingXML: existing))
      let entry = WorkflowHistoryEntry(
        id: UUID().uuidString.lowercased(),
        createdAtMs: UInt64(Date().timeIntervalSince1970 * 1000),
        action: action, label: label,
        parentId: self.pendingSemanticEdits.last?.id ?? self.lineageHeadID,
        writer: WorkflowContract.appleWriter, adjustmentXmp: checkpoint)
      // Invalid actions/checkpoints fail before entering the retry queue.
      _ = try WorkflowSidecarCore.commit(entry, in: checkpoint)
      self.pendingSemanticEdits.append(entry)
      if self.pendingSemanticEdits.count > WorkflowContract.historyLimit {
        self.pendingSemanticEdits.removeFirst(
          self.pendingSemanticEdits.count - WorkflowContract.historyLimit)
      }
      self.pendingTask?.cancel()
      self.pendingTask = nil
      self.pendingModel = model
      self.pendingCulling = culling
      self.cached = (model, culling)
      let saved = try self.writeSidecar(
        model: model, culling: culling, existingXML: existing, at: destination, durable: true)
      self.cached = (saved, culling)
      self.pendingModel = nil
      self.pendingCulling = nil
    }
  }

  /// Workflow operations share the actor and primary path with adjustment writes.
  public func readWorkflow() throws -> SidecarWorkflow? {
    let current = try existingSidecarXML(at: sidecarURL)
    try observeWorkflowRead(current)
    guard let xml = current else {
      try requirePrimaryAbsence()
      return nil
    }
    return try WorkflowSidecarCore.variantWorkflow(xmp: xml, variantId: variantId)
  }

  /// Publish pending authored adjustments and workflow in one atomic replacement.
  /// Validation finishes before the prior sidecar or pending state is changed.
  public func writeWorkflowConfirmed(_ workflow: SidecarWorkflow) throws {
    try coordinateSidecarWrite { destination, existing in
      try self.removalRecovery.requireOrdinaryWrite(xml: existing)
      let xml: String
      if let model = self.pendingModel, let culling = self.pendingCulling {
        xml = try self.serializedSidecar(model: model, culling: culling, existingXML: existing)
      } else {
        xml = existing ?? XMPSerializer.serialize(model: .default, culling: CullingState())
      }
      // Validate the on-disk record even if a serializer would omit it.
      if let existing { try self.requireVariantWorkflow(in: existing) }
      let embedded = try WorkflowSidecarCore.embed(workflow, in: xml)
      try self.requireVariantWorkflow(in: embedded)
      let output = try self.appendingSemanticHistory(to: embedded)
      try self.publishSidecarXML(output, at: destination, durable: true)
      self.pendingSemanticEdits.removeAll()
    }
    pendingTask?.cancel()
    pendingTask = nil
    pendingModel = nil
    pendingCulling = nil
    pendingMetadata = nil
  }

  /// Settle pending authored state with a throwing boundary before reading a checkpoint.
  public func readWorkflowXML() throws -> String? {
    try settleWorkflowWrites()
    let xml = try existingSidecarXML(at: sidecarURL)
    try observeWorkflowRead(xml)
    if xml == nil { try requirePrimaryAbsence() }
    if let xml { try requireVariantWorkflow(in: xml) }
    return xml
  }

  /// Publish a video metadata sidecar against the exact revision last read.
  public func writeMetadataOnly(_ metadata: XmpMetadata) throws {
    try coordinateSidecarWrite { destination, _ in
      let xml = XMPSerializer.serializeMetadataOnly(metadata: metadata)
      try self.publishSidecarXML(xml, at: destination, durable: true)
    }
  }

  /// A first read observes the sidecar. Later reads never refuse: a file that moved on is
  /// merged by the next save, and every publication checks the revision itself.
  private func observeWorkflowRead(_ xml: String?) throws {
    guard !hasObservedSidecar else { return }
    if let xml { lineageHeadID = try WorkflowSidecarCore.headId(xmp: xml, variantId: variantId) }
    observedSidecarXML = xml
    hasObservedSidecar = true
  }

  func adoptObservedRevision(from source: XMPSidecarStore) async {
    let (observed, xml, head) = await source.observedRevisionSnapshot()
    guard observed else { return }
    observedSidecarXML = xml
    hasObservedSidecar = true
    lineageHeadID = head
  }

  private func observedRevisionSnapshot() -> (Bool, String?, String) {
    (hasObservedSidecar, observedSidecarXML, lineageHeadID)
  }

  public func publishWorkflow(_ command: WorkflowPublication) throws -> String {
    try settleWorkflowWrites()
    return try coordinateSidecarWrite { destination, existing in
      try self.removalRecovery.requireOrdinaryWrite(xml: existing)
      let output = try command.output(current: existing, variantId: self.variantId)
      // Parse before publication; a failure never changes the original checkpoint.
      let restored = try XMPParser.parse(output)
      let priorRemovals = try existing.flatMap { try RemovalXMPRecords.read(Data($0.utf8)) } ?? "[]"
      let nextRemovals = restored.0.inpaintRemovals?.json ?? "[]"
      if priorRemovals != "[]" || nextRemovals != "[]" {
        // A complete-XMP restore has the same source/companion requirements as Keep.
        _ = try self.serializedSidecar(
          model: restored.0, culling: restored.1, existingXML: existing,
          removalChange: (priorRemovals, nextRemovals))
      }
      if output != existing {
        try self.publishSidecarXML(output, at: destination, durable: true)
      } else {
        try XMPSidecarFilePublication.confirmExisting(output, at: destination)
      }
      self.cached = restored
      return output
    }
  }

  private func settleWorkflowWrites() throws {
    pendingTask?.cancel()
    pendingTask = nil
    guard let model = pendingModel, let culling = pendingCulling else { return }
    let saved = try writeAtomically(model: model, culling: culling, durable: true)
    pendingModel = nil
    pendingCulling = nil
    cached = (saved, culling)
  }

  /// The queued actions commit on top of `xml`. After a merge the newest one holds the
  /// merged document, so the history head still equals the sidecar.
  func appendingSemanticHistory(to xml: String, merged: Bool = false) throws -> String {
    guard !pendingSemanticEdits.isEmpty else { return xml }
    try requireVariantWorkflow(in: xml)
    var workflow = try WorkflowSidecarCore.read(xmp: xml)
    let mergedCheckpoint = merged ? try WorkflowSidecarCore.checkpoint(xmp: xml) : nil
    for (index, queued) in pendingSemanticEdits.enumerated() {
      if let saved = workflow?.history.first(where: { $0.id == queued.id }) {
        guard saved.isSameAction(as: queued) else {
          throw WorkflowSidecarError(message: "History identity already belongs to another action.")
        }
        continue
      }
      let entry =
        index == pendingSemanticEdits.count - 1 ? queued.holding(mergedCheckpoint) : queued
      let candidate =
        try workflow.map {
          try WorkflowSidecarCore.embed($0, in: entry.adjustmentXmp)
        } ?? entry.adjustmentXmp
      let committed = try WorkflowSidecarCore.commit(entry, in: candidate)
      workflow = try WorkflowSidecarCore.read(xmp: committed)
    }
    guard let workflow else {
      throw WorkflowSidecarError(message: "Committed history did not produce a workflow record")
    }
    return try WorkflowSidecarCore.embed(workflow, in: xml)
  }

  func requireVariantWorkflow(in xml: String) throws {
    _ = try WorkflowSidecarCore.variantWorkflow(xmp: xml, variantId: variantId)
  }

  /// `incoming` over the file's current document. A file that is not the observed
  /// revision is captured and merged by the shared core (#4983); one that vanished
  /// or cannot be merged keeps the pending edit queued.
  func reconcile(incoming: String, existing: String?) throws -> (xml: String, merged: Bool) {
    guard hasObservedSidecar, existing != observedSidecarXML else { return (incoming, false) }
    guard let existing else { throw XMPStoreError.externalConflict(sidecarURL) }
    do {
      if try WorkflowSidecarCore.holdSameAdjustments(existing, observedSidecarXML) {
        return (incoming, false)
      }
      let merged = try WorkflowSidecarCore.reconcile(
        base: observedSidecarXML ?? "", current: existing, incoming: incoming,
        nowMs: UInt64(Date().timeIntervalSince1970 * 1000))
      return (merged, true)
    } catch {
      throw XMPStoreError.externalConflict(sidecarURL)
    }
  }
}

extension XMPSidecarStore: ReconcilingSidecarStoreProtocol {
  public func reconciliations() -> AsyncStream<ReconciledSidecar> {
    reconciliationHub.subscribe()
  }

  public func confirmAdoption(of xml: String) {
    guard let staged = stagedAdoption, staged.published == xml else { return }
    observedSidecarXML = xml
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
