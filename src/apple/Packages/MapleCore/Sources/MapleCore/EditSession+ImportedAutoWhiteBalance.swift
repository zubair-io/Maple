import Foundation

/// A session's name-only imported Auto WB (#4669): the shared estimator's pair
/// once resolved, and the single background request that resolves it.
struct ImportedAutoWhiteBalance {
  typealias Estimate =
    @Sendable (
      _ asset: AssetRef, _ model: AdjustmentModel,
      _ sessionRaw: @escaping @Sendable () async throws -> URL
    ) async throws -> AdjustmentModel

  var target: ResolvedWhiteBalance?
  var request: Task<Void, Never>?
  /// True while `model`'s `didSet` puts the pair back on a replaced model.
  var isOverlaying = false
  /// The background estimate. Tests hold it open to land a late result.
  var estimate: Estimate = { asset, model, sessionRaw in
    try await ImportedWhiteBalanceResolver.resolve(
      asset: asset, model: model, sessionRaw: sessionRaw)
  }
}

@MainActor
extension EditSession {
  /// Cold resolution for a model this session will display. A RAW's name-only
  /// Auto is left to `resolveImportedAutoWhiteBalance`, so it never delays a
  /// frame; any other source resolves it without the estimator.
  func resolvingImportedWhiteBalanceForDisplay(_ model: AdjustmentModel) async throws
    -> AdjustmentModel
  {
    guard !model.awaitsImportedAutoPair || !asset.isRaw else { return model }
    return try await ImportedWhiteBalanceResolver.resolve(asset: asset, model: model)
  }

  /// Resolve a name-only imported Auto WB once per session, never ahead of the
  /// first frame: the shared estimator reads the session's own RAW file (the
  /// core shares its decode), then one re-render shows the pair. The sidecar
  /// keeps the name-only intent. Failure leaves As Shot on screen without an
  /// error, and no final output is taken from it; the next session retries.
  func resolveImportedAutoWhiteBalance() {
    guard importedAuto.request == nil, asset.isRaw, model.awaitsImportedAutoPair else { return }
    let (asset, request, source) = (asset, model, renderActor.rawRenderSource)
    let estimate = importedAuto.estimate
    importedAuto.request = Task { [weak self] in
      let resolved = try? await estimate(asset, request) { try await source.url(for: asset) }
      guard !Task.isCancelled, let target = resolved?.partialWhiteBalance?.resolvedTarget
      else { return }
      self?.adoptImportedAutoWhiteBalance(target)
    }
  }

  /// The re-render after the As Shot first frame. The pair goes on `model` so
  /// the WB sliders show what the canvas renders, and on the open gesture's
  /// baseline so the estimate never becomes an undo step of its own. A 100%
  /// patch developed before it shows As Shot, so it goes too: hydration skips
  /// `model`'s own clear, and the refine would keep a patch that covers the view.
  func adoptImportedAutoWhiteBalance(_ target: ResolvedWhiteBalance) {
    importedAuto.target = target
    if let pending = transactions.pending {
      transactions.pending = PendingEdit(
        id: pending.id, kind: pending.kind, description: pending.description,
        before: pending.before.overlayingImportedAuto(target))
    }
    let shown = model
    isHydratingInitialState = true
    model = model.overlayingImportedAuto(target)
    originalModel = originalModel.overlayingImportedAuto(target)
    isHydratingInitialState = false
    if model != shown { clearNativeDetailPreview() }
    if renderRequested { _scheduleRender(phase: .fast) }
  }

  /// Called first by `model`'s `didSet`: a model that replaced it (undo, redo,
  /// history restore, merge) takes the session's pair again, so the sliders
  /// and the canvas never disagree.
  func overlayImportedAutoPair() {
    guard let target = importedAuto.target, model.awaitsImportedAutoPair else { return }
    importedAuto.isOverlaying = true
    model = model.overlayingImportedAuto(target)
    importedAuto.isOverlaying = false
  }

  /// `model` as a final output (Copy, export) must render it: never As Shot.
  /// It joins this session's estimate when one is running, so an output
  /// shortly after open does not start a second one; the resolver estimates
  /// on its own only when this session has no pair (failed or not started).
  func resolvedForOutput(_ model: AdjustmentModel, isRawOverride: Bool? = nil) async throws
    -> AdjustmentModel
  {
    if model.awaitsImportedAutoPair, importedAuto.target == nil,
      let request = importedAuto.request
    {
      await request.value
    }
    let (asset, source) = (asset, renderActor.rawRenderSource)
    return try await ImportedWhiteBalanceResolver.resolve(
      asset: asset, model: model.overlayingImportedAuto(importedAuto.target),
      isRawOverride: isRawOverride, sessionRaw: { try await source.url(for: asset) })
  }
}
