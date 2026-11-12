import Foundation

/// A session's name-only imported Auto WB (#4669): the shared estimator's pair
/// once resolved, and the single background request that resolves it.
struct ImportedAutoWhiteBalance {
  var target: ResolvedWhiteBalance?
  var request: Task<Void, Never>?
}

@MainActor
extension EditSession {
  /// Cold resolution for a model this session will display. Name-only Auto
  /// is left to `resolveImportedAutoWhiteBalance`, so it never delays a frame.
  func resolvingImportedWhiteBalanceForDisplay(_ model: AdjustmentModel) async throws
    -> AdjustmentModel
  {
    guard model.partialWhiteBalance?.isUnresolvedAuto != true else { return model }
    return try await ImportedWhiteBalanceResolver.resolve(asset: asset, model: model)
  }

  /// Resolve a name-only imported Auto WB once per session, never ahead of the
  /// first frame: the shared estimator reads the session's own RAW file (the
  /// core shares its decode), then one re-render overlays the pair. The stored
  /// model and sidecar keep the name-only intent. Failure leaves As Shot on
  /// screen without an error; the next session for the photo tries again.
  func resolveImportedAutoWhiteBalance() {
    guard importedAuto.request == nil, asset.isRaw,
      model.partialWhiteBalance?.isUnresolvedAuto == true
    else { return }
    let (asset, request, source) = (asset, model, renderActor.rawRenderSource)
    importedAuto.request = Task { [weak self] in
      let resolved = try? await ImportedWhiteBalanceResolver.resolve(
        asset: asset, model: request, sessionRaw: { try await source.url(for: asset) })
      guard !Task.isCancelled, let target = resolved?.partialWhiteBalance?.resolvedTarget
      else { return }
      self?.adoptImportedAutoWhiteBalance(target)
    }
  }

  /// The re-render after the As Shot first frame. Undo snapshots taken before
  /// the pair arrived render it too, through `renderModel`.
  func adoptImportedAutoWhiteBalance(_ target: ResolvedWhiteBalance) {
    importedAuto.target = target
    isHydratingInitialState = true
    model = model.overlayingImportedAuto(target)
    originalModel = originalModel.overlayingImportedAuto(target)
    isHydratingInitialState = false
    if renderRequested { _scheduleRender(phase: .fast) }
  }
}
