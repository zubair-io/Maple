// EditSession+Lifecycle.swift — public editor-lifecycle helpers split out of
// EditSession.swift for the file-size budget (#2009). Keyword editing +
// pending-sidecar flush; both are teardown/metadata operations with no pixel
// impact, kept off the core type declaration.

import Foundation

@MainActor
extension EditSession {
  /// Keep the existing asynchronous updates ordered without waiting on the UI
  /// path. The tail also gives exit a real completion barrier, instead of
  /// hoping an unstructured update reaches the store before `flush()`.
  func scheduleSidecarUpdate(model: AdjustmentModel, culling: CullingState) {
    // Nothing is persisted before the sidecar has loaded (#4708).
    guard hasLoadedSidecar, !workflow.isApplying else { return }
    if sidecarWritesDisabled {
      sidecarDirtyWhileDisabled = true
      return
    }
    guard let store = sidecarStore else { return }
    sidecarUpdateGeneration &+= 1
    let previous = sidecarUpdateTask
    sidecarUpdateTask = Task {
      await previous?.value
      guard !self.sidecarWritesDisabled, !Task.isCancelled else { return }
      await store.update(model: model, culling: culling)
    }
  }

  /// Rate, flag, label or hide only after the sidecar has loaded, so the
  /// write merges over the saved develop settings instead of defaults.
  /// Calls apply in the order they were made: rapid shortcuts during a slow
  /// read each wait on hydration, and the last one must win.
  public func setCulling(_ edit: @escaping (inout CullingState) -> Void) async throws {
    let previous = cullingEditTail
    let step = Task { () -> Error? in
      _ = await previous?.value
      await loadSidecar()
      if Task.isCancelled { return CancellationError() }
      guard hasLoadedSidecar else { return sidecarError ?? CancellationError() }
      edit(&culling)
      return nil
    }
    cullingEditTail = step
    let failure = await withTaskCancellationHandler {
      await step.value
    } onCancel: {
      step.cancel()
    }
    if let failure { throw failure }
  }

  /// Replace the IPTC keyword list (#632). Routes through `culling`'s
  /// `didSet` which schedules the same 750ms-debounced XMP write the
  /// rating/flag mutators use — keywords have zero pixel impact so the
  /// render path is intentionally not kicked. Duplicates are removed
  /// preserving first-occurrence order (`Set` would lose order); blank
  /// entries are dropped since `dc:subject` rejects empty `rdf:li`
  /// content on the read path.
  public func setKeywords(_ keywords: [String]) {
    var seen: Set<String> = []
    var deduped: [String] = []
    for raw in keywords {
      let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty, !seen.contains(trimmed) else { continue }
      seen.insert(trimmed)
      deduped.append(trimmed)
    }
    guard culling.keywords != deduped else { return }
    culling.keywords = deduped
  }

  /// Force an immediate flush of any pending sidecar write. Call before
  /// tearing the editor down so an undo-then-leave sequence persists
  /// the right value (spec § S5 risk #4b). No-op when there's no store
  /// (e.g. preview session, in-memory test).
  ///
  /// Routes through the protocol's `flush()` requirement directly rather
  /// than an `as?` typecast chain over the concrete store types — every
  /// conformer (`XMPSidecarStore`, `PhotoKitSidecarStore`,
  /// `CloudSidecarStore`, `SMBSidecarStore`) implements `flush()` with the
  /// identical "cancel the pending debounce Task, then force the write
  /// now" shape, so there is nothing per-type left to special-case. A
  /// typecast chain silently no-ops for any store type it doesn't
  /// enumerate — which is exactly how `SMBSidecarStore` fell through here
  /// (#2674 review): an edit made within the 750ms debounce window right
  /// before leaving the editor was dropped for SMB sessions because this
  /// method never reached the store at all. Reviewed in #2556 for the
  /// same reason.
  public func flushPendingSidecarWrite() async {
    try? await flushPendingSidecarWriteConfirmed()
  }

  /// Flush any pending sidecar write and throw if an unconfirmed edit cannot
  /// be durably persisted (#4711).
  public func flushPendingSidecarWriteConfirmed() async throws {
    // A rating queued before load is merged and saved once the load lands (#4708).
    if !hasLoadedSidecar, queuedCullingPatch != nil { await loadSidecar() }
    // An unloaded session holds defaults, not the photo's edits: never write
    // them, even when the store would accept it. A queued rating that cannot
    // be merged is an unpersisted edit, so it fails the confirmed flush.
    guard hasLoadedSidecar else {
      if queuedCullingPatch != nil { throw sidecarError ?? CancellationError() }
      return
    }
    while true {
      await workflow.waitForIdle()
      // A flush is a commit boundary (#2432): close the open transaction
      // so the sidecar describes a recorded action, not a half-gesture.
      endEdit()
      guard !sidecarWritesDisabled, let store = sidecarStore else { return }
      while let task = sidecarUpdateTask {
        await task.value
        if sidecarUpdateTask == task {
          sidecarUpdateTask = nil
        }
      }
      if workflow.hasExternalOperationInFlight { continue }
      if hasUnconfirmedSidecarUpdate {
        let generation = sidecarUpdateGeneration
        do {
          try await store.writeConfirmed(model: model, culling: culling)
          if sidecarUpdateGeneration == generation {
            confirmedSidecarGeneration = generation
            sidecarError = nil
          }
        } catch {
          sidecarDirtyWhileDisabled = true
          sidecarError = error
          throw error
        }
      } else {
        await store.flush()
      }
      if sidecarUpdateTask == nil, !hasUnconfirmedSidecarUpdate,
        !workflow.hasExternalOperationInFlight
      {
        break
      }
    }
  }

  /// Enable or disable sidecar/preview writes on this session (#4711).
  /// Call after `flushPendingSidecarWrite()` and before renaming the asset so
  /// any in-flight sidecar or preview write finishes before the file moves and
  /// no late debounce timer or editor-exit teardown can resurrect the old path;
  /// re-enable if the rename fails, replaying any edit made while disabled.
  public func setSidecarWritesEnabled(_ enabled: Bool) async {
    sidecarWritesDisabled = !enabled
    if enabled {
      previewPersistence.rearmIfPending()
      guard sidecarDirtyWhileDisabled else { return }
      sidecarDirtyWhileDisabled = false
      let previousTask = sidecarUpdateTask
      endEdit()
      if sidecarUpdateTask == previousTask {
        scheduleSidecarUpdate(model: model, culling: culling)
      }
      return
    }
    await workflow.waitForIdle()
    sidecarDirtyWhileDisabled =
      sidecarDirtyWhileDisabled || hasUnconfirmedSidecarUpdate || sidecarUpdateTask != nil
    let store = workflow.selectedStore ?? primarySidecarStore
    while let task = sidecarUpdateTask {
      task.cancel()
      await task.value
      if sidecarUpdateTask == task {
        sidecarUpdateTask = nil
      }
    }
    await store?.flush()
    await previewPersistence.cancelAndJoin()
  }

  /// Carry over undo history and any edits made on `departing` while its
  /// sidecar writes were disabled during an in-flight rename (#4711).
  public func adoptInFlightRenameEdits(from departing: EditSession) {
    if let pendingPreview = departing.previewPersistence.takePendingImage() {
      scheduleDisplayPreviewPersist(pendingPreview)
    }
    departing.endEdit()
    let hasDirtyEdits =
      departing.sidecarDirtyWhileDisabled || departing.hasUnconfirmedSidecarUpdate
      || departing.sidecarUpdateTask != nil
    // A session that never loaded holds defaults, not the photo's edits;
    // this one hydrates itself, keeping any rating queued on the old (#4708).
    guard departing.hasLoadedSidecar else {
      queuedCullingPatch = departing.queuedCullingPatch
      return
    }
    departing.sidecarDirtyWhileDisabled = false
    departing.confirmedSidecarGeneration = departing.sidecarUpdateGeneration
    departing.sidecarError = nil
    departing.sidecarUpdateTask?.cancel()
    departing.sidecarUpdateTask = nil
    isHydratingInitialState = true
    originalModel = departing.originalModel
    asShotCCT = departing.asShotCCT
    asShotTint = departing.asShotTint
    culling = departing.culling
    model = departing.model
    isHydratingInitialState = false
    transactions = departing.transactions
    lastCommittedTransaction = departing.lastCommittedTransaction
    hasLoadedSidecar = true
    if hasDirtyEdits {
      scheduleSidecarUpdate(model: model, culling: culling)
    }
  }
}
