// PreviewStillLoader.swift — the stills a Preview page shows before (and
// instead of) a render (#5762): the grid's decoded tile, the grid thumbnail,
// then the display tier (`.maple/previews`, the server's `/api/fs/preview`, a
// PhotoKit high-quality request). The visible page draws them beneath the
// shared canvas; a neighbouring page shows them alone.
//
// The page's `.task`s drive every load, so leaving the page or changing its
// photo cancels them. A visible page whose display tier failed retries it on
// `PreviewRefinementBackoff`'s schedule (#5432) until the tier lands, the
// source answers "not found", or the page is left.

import CoreGraphics
import MapleCore
import Observation

@MainActor
@Observable
final class PreviewStillLoader {
  enum Phase: Equatable {
    case loading
    case loaded
    case failed
  }

  let asset: AssetRef
  let source: ThumbnailSource
  private let provider: ThumbnailProvider

  private(set) var image: CGImage?
  private(set) var phase: Phase = .loading
  /// The display tier landed or its first attempt failed: the still may no
  /// longer get sharper soon, so zooming past it needs the render.
  private(set) var isDisplayTierSettled = false
  private var hasDisplayTier = false
  /// The source answered "not found"; asking again on a revisit would
  /// repeat the same 404.
  @ObservationIgnored private var displayTierUnavailable = false
  @ObservationIgnored private var firstPaintFailed = false
  @ObservationIgnored private var preparedKey: String?
  /// A still the editor handed back: a smaller thumbnail does not replace it.
  @ObservationIgnored private var handedOffLongEdge = 0

  init(asset: AssetRef, source: (any ImageSource)?, provider: ThumbnailProvider) {
    self.asset = asset
    self.source = PreviewViewVM.thumbnailSource(for: asset, source: source)
    self.provider = provider
  }

  /// The still's long edge in pixels; 0 before one is shown.
  var longEdgePixels: CGFloat {
    image.map { CGFloat(max($0.width, $0.height)) } ?? 0
  }

  /// Changes when an editor save re-develops the photo, so the page reloads.
  var reloadKey: String {
    DevelopedImageRevision.shared.reloadKey(for: seedKey, source: source)
  }

  /// The grid cell's decoded tile is cached under the same key
  /// `PhotoGridItem(local:)` uses, so the page paints it on its first frame.
  private var seedKey: String { asset.stableID ?? asset.id.uuidString }

  /// Every load starts here: for a new `reloadKey` (a re-developed photo) the
  /// tiers are forgotten once, whichever load runs first. The old still stays
  /// on screen until the new one replaces it.
  func prepare(for key: String) {
    guard key != preparedKey else { return }
    let isReload = preparedKey != nil
    preparedKey = key
    guard isReload else { return }
    hasDisplayTier = false
    isDisplayTierSettled = false
    displayTierUnavailable = false
    firstPaintFailed = false
    handedOffLongEdge = 0
  }

  /// The grid tile, then the grid thumbnail. A missing thumbnail falls back
  /// to the display tier, which a neighbouring page otherwise never asks for;
  /// on a single-tier source the visible page's own display-tier load is that
  /// same artifact, so it is not fetched twice.
  func loadFirstPaint(displayTierDimension: CGFloat, isVisible: Bool) async {
    let key = await DevelopedImageRevision.shared.decodedKeyAsync(for: seedKey, source: source)
    if image == nil, !Task.isCancelled, let tile = ThumbnailDecoder.cachedImage(forKey: key) {
      show(tile, isDisplayTier: false)
      log(.seed, .finish, targetPx: CGFloat(max(tile.width, tile.height)))
    }
    let started = ContinuousClock.now
    log(.thumb, .start)
    let data = await provider.thumbnail(for: source) { [weak self] camera in
      guard let self, let image = await ThumbnailDecoder.decodeFull(camera), !Task.isCancelled
      else { return }
      show(image, isDisplayTier: false)
    }
    guard !Task.isCancelled else { return log(.thumb, .cancel, since: started) }
    if let data, let thumbnail = await ThumbnailDecoder.decodeFull(data), !Task.isCancelled {
      log(.thumb, .finish, bytes: data.count, since: started)
      show(thumbnail, isDisplayTier: false)
      return
    }
    log(
      .thumb, .fail, bytes: data?.count, since: started,
      reason: data == nil ? "no thumbnail" : "undecodable")
    guard !Task.isCancelled, !hasDisplayTier else { return }
    firstPaintFailed = true
    guard !(isVisible && source.hasFixedPreviewTier) else {
      if isDisplayTierSettled, image == nil { phase = .failed }
      return
    }
    guard
      let previewData = await provider.preview(for: source, maxDimension: displayTierDimension),
      let preview = await ThumbnailDecoder.decodeFull(previewData), !Task.isCancelled
    else {
      if !Task.isCancelled, image == nil { phase = .failed }
      return
    }
    show(preview, isDisplayTier: true)
  }

  /// The display tier for the visible page, retried after a transient
  /// failure for as long as the calling task runs.
  func loadDisplayTier(maxDimension: CGFloat) async {
    var backoff = PreviewRefinementBackoff()
    while !Task.isCancelled, !hasDisplayTier, !displayTierUnavailable {
      let started = ContinuousClock.now
      log(.refine, .start, targetPx: maxDimension)
      let outcome = await provider.previewOutcome(for: source, maxDimension: maxDimension)
      let decoded: CGImage? =
        if let data = outcome.data { await ThumbnailDecoder.decodeFull(data) } else { nil }
      guard !Task.isCancelled else { return log(.refine, .cancel, targetPx: maxDimension) }
      if let decoded {
        show(decoded, isDisplayTier: true)
        log(.refine, .finish, targetPx: maxDimension, bytes: outcome.data?.count, since: started)
        return
      }
      let failure = outcome.data == nil ? outcome : .notFound(reason: "undecodable")
      isDisplayTierSettled = true
      guard let delay = backoff.delay(after: failure) else {
        log(
          .refine, .fail, targetPx: maxDimension, since: started,
          reason: "\(failure.reason ?? "unknown"); not retrying")
        displayTierUnavailable = true
        if image == nil, firstPaintFailed { phase = .failed }
        return
      }
      log(
        .refine, .fail, targetPx: maxDimension, since: started,
        reason: "\(failure.reason ?? "unknown"); retry in \(Int(delay))s")
      try? await Task.sleep(for: .seconds(delay))
    }
  }

  /// The still on screen, for the editor to open with (#5764).
  var handoffStill: CanvasHandoffStill? {
    image.map { CanvasHandoffStill(image: $0, isDisplayPreview: hasDisplayTier) }
  }

  /// The still the editor showed, until this page's own loads land. It may
  /// predate the edits, so it never stands in for the display tier.
  func showHandedOff(_ still: CanvasHandoffStill) {
    guard image == nil else { return }
    show(still.image, isDisplayTier: false)
    handedOffLongEdge = max(still.image.width, still.image.height)
  }

  /// Nothing smaller replaces the display tier once it is shown.
  private func show(_ still: CGImage, isDisplayTier: Bool) {
    guard isDisplayTier || !hasDisplayTier,
      isDisplayTier || max(still.width, still.height) >= handedOffLongEdge
    else { return }
    image = still
    phase = .loaded
    if isDisplayTier {
      hasDisplayTier = true
      isDisplayTierSettled = true
    }
  }

  private func log(
    _ stage: PreviewLoadLog.Stage, _ event: PreviewLoadLog.Event, targetPx: CGFloat? = nil,
    bytes: Int? = nil, since start: ContinuousClock.Instant? = nil, reason: String? = nil
  ) {
    PreviewLoadLog.record(
      stage: stage, event: event, assetID: seedKey, sourceKind: source.previewLogKind,
      targetPx: targetPx.map { Int($0) }, bytes: bytes,
      elapsedMs: start.map(PreviewLoadLog.milliseconds(since:)), reason: reason)
  }
}
