import CoreImage
import Foundation

@MainActor
extension EditSession {
  /// Return false for superseded work. Only an actual cold/replacement fit
  /// needs the source URL; ready artifacts and pending same-decode requests
  /// reuse their owned state without source-actor round trips (#1472).
  func prepareGpuAutoProfile(
    driver: GpuLiveDriver, model: AdjustmentModel,
    decodeGeneration: UInt64, quality: PipelineRenderer.Quality, gen: UInt64?
  ) async -> Bool {
    guard !Task.isCancelled else { return false }
    if let prepared = nativeAutoProfile.readyFor(
      decodeGeneration: decodeGeneration, quality: AmazeFlag.isEnabled ? .amaze : .full)
    {
      await driver.installNativeAutoProfile(prepared)
      return !Task.isCancelled
    }
    if driver.needsAutoProfileFit {
      // Cloud RAWs share the session's staged file with decode/export. The
      // source owner stays retained through the joined fit's actual return.
      guard let url = try? await renderActor.rawRenderSource.url(for: asset) else {
        return !Task.isCancelled
      }
      if let gen, gen != (await renderActor.currentGeneration()) { return false }
      guard !Task.isCancelled else { return false }
      let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
      let accessing = scope.startAccessingSecurityScopedResource()
      defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
      await driver.fitAutoProfileIfNeeded(rawPath: url.path, model: model, quality: quality)
    }
    guard !Task.isCancelled else { return false }
    let nativeQuality: PipelineRenderer.Quality = AmazeFlag.isEnabled ? .amaze : .full
    if !nativeAutoProfile.isRequested(
      decodeGeneration: decodeGeneration, quality: nativeQuality)
    {
      // The full native develop shares CPU workers with the provisional fit.
      // Start it only after that fit returns, and reject a stale caller before
      // it can rewind a newer native request after the fit await.
      if let gen, gen != (await renderActor.currentGeneration()) { return false }
      guard !Task.isCancelled else { return false }
      if let prepared = preparedNativeAutoProfile(decodeGeneration: decodeGeneration) {
        await driver.installNativeAutoProfile(prepared)
      }
    }
    return !Task.isCancelled
  }

  /// Mac uses the same full-quality Auto tail as its full export, independent
  /// of the bounded preview's demosaic/resolution. The provisional proxy stays
  /// visible until preparation completes. iOS retains its existing memory gate
  /// and proxy policy; ports are deferred under #1472.
  func preparedNativeAutoProfile(decodeGeneration: UInt64) -> NativeAutoProfile? {
    #if os(macOS)
      return nativeAutoProfile.prepared(
        asset: asset, source: renderActor.rawRenderSource,
        quality: AmazeFlag.isEnabled ? .amaze : .full, decodeGeneration: decodeGeneration
      ) { [weak self] in
        guard let self, self.renderModel.profile == .auto else { return }
        self.clearNativeDetailPreview()
        self.scheduleNativeAutoRefresh()
      }
    #else
      return nil
    #endif
  }

  var hasSettledAutoProfile: Bool {
    isSettledAutoProfile(
      gpuFramePresented && !gpuPresentFailed
        ? gpuLiveDriver?.nativeAutoProfileID : nativeAutoFrameID)
  }

  var hasSettledCPUAutoProfile: Bool { isSettledAutoProfile(nativeAutoFrameID) }

  private func isSettledAutoProfile(_ frameID: UUID?) -> Bool {
    #if os(macOS)
      guard asset.isRaw, renderModel.profile == .auto, nativeAutoProfile.hasRequested else {
        return true
      }
      guard let ready = nativeAutoProfile.ready else { return false }
      return frameID == ready.id
    #else
      return true
    #endif
  }

  /// Used by CPU fallback and 1:1 detail so either surface uses the same
  /// prepared native tail as the live canvas. A valid absent fit is distinct
  /// from an unfinished job. Only provisional/iOS renders use a CI cube.
  func autoProfileLUTForCPURender(
    asset: AssetRef, model: AdjustmentModel, quality: PipelineRenderer.Quality,
    decodeGeneration: UInt64
  ) async -> (filter: CIFilter?, native: NativeAutoProfile?) {
    guard asset.isRaw, model.profile == .auto else { return (nil, nil) }
    if let prepared = preparedNativeAutoProfile(decodeGeneration: decodeGeneration) {
      return (nil, prepared)
    }
    guard let url = try? await renderActor.rawRenderSource.url(for: asset) else {
      return (nil, nil)
    }
    let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
    let accessing = scope.startAccessingSecurityScopedResource()
    defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
    let proxy = await AutoProfileLUT.shared.filter(
      forRawAt: url, profile: model.profile, quality: quality)
    // Preparation can finish while the provisional fit is awaited.
    if let prepared = nativeAutoProfile.readyFor(
      decodeGeneration: decodeGeneration, quality: AmazeFlag.isEnabled ? .amaze : .full)
    {
      return (nil, prepared)
    }
    return (proxy, nil)
  }

  /// Refresh only the display tail, on the existing generation. A completed
  /// native fit must not supersede an explicit companion-recovery render.
  private func scheduleNativeAutoRefresh() {
    guard let expected = nativeAutoProfile.ready?.id else { return }
    let actor = renderActor
    Task { [weak self] in
      let gen = await actor.currentGeneration()
      guard let self, self.nativeAutoProfile.ready?.id == expected else { return }
      await actor.scheduleRefine(expectedGeneration: gen) { @MainActor [weak self] gen in
        guard let self, self.nativeAutoProfile.ready?.id == expected,
          self.renderModel.profile == .auto
        else { return }
        await self.decodeAndRender(targetSize: self.fastTargetSize, phase: .fast, gen: gen)
      }
    }
  }

}
