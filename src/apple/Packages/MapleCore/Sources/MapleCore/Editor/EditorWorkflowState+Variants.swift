import CoreImage
import Foundation

struct WorkflowVariantCreation {
  let record: SidecarWorkflow
  let sourceVariantId: String
  let checkpoint: String
}

@MainActor
extension EditorWorkflowState {
  public func createVariant(name: String, session: EditSession) async {
    guard !isBusy else { return }
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      errorText = "Enter a variant name."
      return
    }
    session.endEdit()
    isBusy = true
    let current = generation
    defer { if generation == current { isBusy = false } }
    do {
      await session.loadSidecar()
      await session.sidecarUpdateTask?.value
      let root = try variantStore(session)
      guard let source = session.sidecarStore as? any WorkflowSidecarStoreProtocol else {
        throw WorkflowSidecarError(message: "This source has no writable sidecar.")
      }
      let command: WorkflowVariantCreation
      if let pendingVariant, pendingVariant.record.variantName == trimmed,
        pendingVariant.sourceVariantId == selectedVariantId
      {
        command = pendingVariant
      } else {
        if try await source.readWorkflowXML() == nil {
          try await source.writeConfirmed(model: session.model, culling: session.culling)
        }
        guard let xml = try await source.readWorkflowXML(), generation == current else { return }
        let record = SidecarWorkflow(
          schemaVersion: 1, variantId: UUID().uuidString.lowercased(),
          variantName: trimmed, snapshots: [], history: [])
        command = WorkflowVariantCreation(
          record: record, sourceVariantId: selectedVariantId,
          checkpoint: try WorkflowSidecarCore.checkpoint(
            xmp: WorkflowSidecarCore.embed(record, in: xml)))
        pendingVariant = command
      }
      do {
        try await root.createWorkflowVariant(
          command.record, sourceVariantId: command.sourceVariantId)
      } catch {
        // A lost acknowledgement reuses its UUID only for the identical saved branch.
        guard let binding = try? await root.bindWorkflowVariant(command.record.variantId),
          let xml = try? await binding.writer.readWorkflowXML(),
          try WorkflowSidecarCore.read(xmp: xml) == command.record,
          try WorkflowSidecarCore.checkpoint(xmp: xml) == command.checkpoint
        else { throw error }
      }
      guard generation == current else { return }
      try await select(session: session, variantId: command.record.variantId, generation: current)
      pendingVariant = nil
      errorText = nil
    } catch { if generation == current { errorText = error.localizedDescription } }
  }

  public func selectVariant(_ variantId: String, session: EditSession) async {
    guard !isBusy, selectedVariantId != variantId else { return }
    session.endEdit()
    isBusy = true
    let current = generation
    defer { if generation == current { isBusy = false } }
    do {
      try await select(session: session, variantId: variantId, generation: current)
      errorText = nil
    } catch { if generation == current { errorText = error.localizedDescription } }
  }

  private func select(session: EditSession, variantId: String, generation current: UInt64)
    async throws
  {
    let root = try variantStore(session)
    await session.loadSidecar()
    await session.sidecarUpdateTask?.value
    let oldModel = session.model
    let editID = session.transactions.nextID
    if session.renderRequested {
      previews.captureXML = try await (session.sidecarStore as? any WorkflowSidecarStoreProtocol)?
        .readWorkflowXML()
      defer { previews.captureXML = nil }
      await session.persistDisplayPreviewOnExit()
      if session.previewIsFullRender, !session.isFullQualityDecoding,
        let image = session.renderedPreview, let xml = previews.captureXML,
        session.model == oldModel
      {
        previews.store(
          image, id: selectedVariantId, xml: xml, model: oldModel,
          width: Int(session.previewSize.width))
      }
    }
    let binding = try await root.bindWorkflowVariant(variantId)
    let xml = try await binding.writer.readWorkflowXML()
    if let xml { _ = try WorkflowSidecarCore.variantWorkflow(xmp: xml, variantId: variantId) }
    let restored: (AdjustmentModel, CullingState)
    if let xml {
      restored = try await restoredState(xml, session: session)
    } else {
      restored = (
        EditSession.initialModel(
          loadedModel: nil, asShotCCT: session.asShotCCT,
          asShotTint: session.asShotTint), CullingState()
      )
    }
    let listed = try await root.listWorkflowVariants()
    guard generation == current, session.model == oldModel, session.transactions.nextID == editID
    else {
      releaseRasters(restored.0)
      return
    }
    await session.previewPersistence.cancelAndJoin()
    await session.renderActor.cancelAll()
    guard generation == current, session.model == oldModel,
      session.transactions.nextID == editID
    else {
      releaseRasters(restored.0)
      return
    }
    session.previewPersistence.discardPendingImage()
    selectedStore = binding.writer
    session.observeSidecarErrors()
    selectedVariantId = variantId
    session.asset.selectedSidecarURL = binding.sidecarURL
    session.applyWorkflowVariant(restored)
    clearBranchCommands()
    try adoptDocument(xml)
    variants = listed
    session.renderedPreview = previews.preview(
      id: variantId, xml: xml,
      model: restored.0, width: Int(session.previewSize.width))
    if let raw = session.asset.primaryURL, session.previewSize.width >= 1,
      let image = await RenderedPreviewCache.shared.preview(
        for: raw,
        screenWidth: Int(session.previewSize.width), sidecarURL: binding.sidecarURL),
      generation == current
    {
      session.renderedPreview = image
    }
    guard generation == current else { return }
    if session.renderRequested { session._scheduleRender(phase: .fast) }
    session.announcer.announce(
      variantId == WorkflowContract.primaryVariantID
        ? "Primary variant selected" : "Variant selected")
  }

  private func variantStore(_ session: EditSession) throws
    -> any WorkflowVariantSidecarStoreProtocol
  {
    guard let root = session.primarySidecarStore as? any WorkflowVariantSidecarStoreProtocol else {
      throw WorkflowSidecarError(
        message: "Variants need a writable local, Photos or server source.")
    }
    return root
  }
}

@MainActor
extension EditSession {
  func applyWorkflowVariant(_ restored: (AdjustmentModel, CullingState)) {
    isHydratingInitialState = true
    defer { isHydratingInitialState = false }
    model = restored.0
    originalModel = restored.0
    culling = restored.1
    hasLoadedSidecar = true
    transactions = EditTransactionRing(nextID: transactions.nextID &+ 1)
    lastCommittedTransaction = nil
    wbSeedTemperature = nil
    wbSeedTint = nil
    renderedPreview = nil
    previewIsFullRender = false
    previewIsThumbnailSeed = false
    gpuFramePresented = false
    clearNativeDetailPreview()
    disabledMaskIds = []
    selectedMaskId = nil
    sidecarError = nil
    partialWhiteBalanceImportError = nil
    renderError = nil
  }
}
