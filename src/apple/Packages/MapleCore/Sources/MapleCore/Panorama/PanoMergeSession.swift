// PanoMergeSession.swift — Observable state for a panorama merge.
//
// Owns two independent lifecycles:
//   preview:  idle → running → ready | failed   (automatic, re-run on option change)
//   stitch:   idle → running → done | error      (the user's "Create Panorama")
//
// The preview's solved alignment is held here, in memory, and offered to
// every later preview and to the full stitch so matching is not repeated.
//
// Generation-counter discipline (per docs/best-practices.md §"Generation
// counters for async state") ensures that a cancelled or superseded run can
// never publish stale progress or results.
//
// Ticket: #1236 / Part of #1234 / #4579

import Foundation

// MARK: - PanoMergeSession

@MainActor
@Observable
public final class PanoMergeSession {
  // MARK: - State machine

  public private(set) var state: RunState = .idle
  public private(set) var previewState: PreviewState = .idle
  /// Alignment progress of the stitch's own re-alignment, which runs when
  /// the finished preview was solved for other options. `nil` otherwise.
  private(set) var freshAlignmentFraction: Double?
  /// The running stitch spent time in `.finishingAlignment`, so its
  /// progress shares one bar between that phase and the composite.
  private(set) var stitchIncludesAlignment = false

  /// The latest finished preview for the current frames. Stays visible
  /// while a re-preview runs, so an option change doesn't blank the view.
  public private(set) var lastPreview: PanoPreview?

  /// The most recent solved alignment, offered to the next preview and the
  /// full stitch of the same frames. Kept even when a later preview fails:
  /// the core rejects a mismatched alignment itself, so offering it is
  /// always safe. Dropped when other frames are previewed, which it could
  /// never match.
  public private(set) var alignment: PanoAlignment?
  private var alignmentFrames: [AssetRef.ID] = []

  /// How cloud-only frames can still stitch on this device: download them
  /// first (#5489). `nil` when the frames are not on a Maple server.
  public var downloadRoute: PanoDownloadRoute?

  /// True while a stitch is in-flight. Derived from `state` so views don't
  /// need a switch to drive a spinner.
  public var isRunning: Bool {
    switch state {
    case .running, .finishingAlignment: return true
    case .idle, .done, .error: return false
    }
  }

  public var isPreviewing: Bool {
    switch previewState {
    case .scheduled, .running: return true
    case .idle, .ready, .failed: return false
    }
  }

  // MARK: - Options (mutable before/after a run; not during)

  /// Changing an option while a preview is active re-runs it. A change to
  /// the geometry the alignment is keyed on cancels the run in flight and
  /// re-runs after `previewDebounce`; a composite-only change (retention,
  /// local alignment) lets the running preview finish its matching, then
  /// re-previews from that alignment with the new options.
  public var options: PanoOptions = .default {
    didSet {
      if options.withoutEdges != oldValue.withoutEdges
        || options.boundaryWarp != oldValue.boundaryWarp
      {
        options.seamConstraints = nil
      }
      if options.withoutEdges == oldValue.withoutEdges,
        options.boundaryWarp == oldValue.boundaryWarp,
        options.autoCrop == oldValue.autoCrop
      {
        return
      }
      guard options != oldValue, previewAssets.count >= 2, !isRunning else { return }
      previewIsEdgesOnly =
        alignment != nil && options.withoutEdges == oldValue.withoutEdges
        && (previewIsEdgesOnly || !isPreviewing)
      if case .running = previewState, previewRunStrategy == options.strategy {
        rePreviewWhenCurrentFinishes = true
        return
      }
      schedulePreview(after: previewDebounce)
    }
  }

  // MARK: - Edges (#5575)

  /// What the engine did with Boundary Warp and Auto Crop: the finished
  /// stitch's report, else the latest preview's. It stays until a newer
  /// report replaces it, so a reason does not vanish while a re-preview runs.
  public var edgesReport: PanoEdgesReport? {
    if case .done(let result) = state, let report = result.edges { return report }
    return lastPreview?.edges
  }

  /// The preview now scheduled or running was started only by an edge
  /// setting changing, so it re-composites from the alignment already held.
  public private(set) var previewIsEdgesOnly = false

  // MARK: - Output size (#5454)

  /// The output size the next stitch uses: the user's choice, else
  /// `.fitted` whenever a smaller output is on offer. Always `.full` when
  /// it is not, so the merge sheet never selects an option it isn't showing.
  public var outputSize: PanoOutputSize {
    get {
      guard fittedOutput != nil else { return .full }
      return chosenOutputSize ?? .fitted
    }
    set { chosenOutputSize = newValue }
  }

  /// How the full stitch of the latest preview fits this device's memory,
  /// read once when that preview lands so the sheet and the stitch agree;
  /// `nil` before a preview, or where the platform has no per-process
  /// memory limit (macOS). After a geometry change it describes the
  /// previous geometry until the new preview lands; `start` previews the
  /// current geometry first rather than stitch against it.
  public private(set) var memoryFit: PanoMemoryFit? {
    didSet { if memoryFit == nil { memoryFitOptions = nil } }
  }

  /// How the full stitch of the latest preview fits the free space on
  /// this device, read with `memoryFit`; `nil` before a preview or when
  /// the stitch runs elsewhere.
  public private(set) var diskFit: PanoDiskFit?

  // MARK: - Private

  public private(set) var stitcher: any PanoStitching
  private let memoryModel: PanoMemoryModel
  private let diskModel = PanoDiskModel()
  private let availableMemory: @Sendable () -> Int?
  private let freeSpace: @Sendable (any PanoStitching, [AssetRef]) -> PanoFreeSpace?
  private let backgroundPause: (any PanoBackgroundPausing)?
  private var chosenOutputSize: PanoOutputSize?
  /// Options the latest finished preview, and so `memoryFit`, was solved
  /// for. Every option reaches the solver (retention and local alignment
  /// decide which frames survive), so any of them can change the canvas.
  /// Always `withoutEdges`: the edge settings leave the canvas size alone.
  private var memoryFitOptions: PanoOptions?
  private var previewBoundaryWarp: Double?
  private let previewDebounce: Duration
  private var runGeneration: UInt64 = 0
  private var previewGeneration: UInt64 = 0
  private var previewTask: Task<Void, Never>?
  /// The latest stitch run; the next one waits for it to unwind so two
  /// full stitches never hold their canvases at once.
  private var runTask: Task<Void, Never>?
  private var previewAssets: [AssetRef] = []
  /// Geometry option the in-flight preview run solves for.
  private var previewRunStrategy: PanoOptions.Strategy?
  /// A composite-only option changed while a preview was matching.
  private var rePreviewWhenCurrentFinishes = false

  public init(
    stitcher: any PanoStitching,
    previewDebounce: Duration = .milliseconds(600),
    availableMemory: @escaping @Sendable () -> Int? = { PanoAvailableMemory.current() },
    isPhone: Bool = MapleShellKind.currentIdiom == .phone,
    freeSpace: @escaping @Sendable (any PanoStitching, [AssetRef]) -> PanoFreeSpace? = {
      $0.freeSpace(for: $1)
    },
    backgroundPause: (any PanoBackgroundPausing)? = nil
  ) {
    self.backgroundPause = backgroundPause
    self.stitcher = stitcher
    self.previewDebounce = previewDebounce
    self.availableMemory = availableMemory
    memoryModel = PanoMemoryModel(
      smallerDefaultFraction: isPhone ? PanoMemoryModel.phoneSmallerDefaultFraction : nil)
    self.freeSpace = freeSpace
  }

  // MARK: - Preview API

  /// Start the automatic preview for `assets` immediately. Later option
  /// changes re-run it (debounced) until `cancel()` or a stitch starts.
  /// Fewer than two frames clears the preview. Ignored while a stitch
  /// runs: a preview beside it would compete for the same memory.
  public func preview(assets: [AssetRef]) {
    guard !isRunning else { return }
    if assets.map(\.id) != alignmentFrames { alignment = nil }
    if assets.map(\.id) != previewAssets.map(\.id) {
      lastPreview = nil
      options.seamConstraints = nil
      memoryFit = nil
      diskFit = nil
      chosenOutputSize = nil
    }
    previewAssets = assets
    previewIsEdgesOnly = false
    guard assets.count >= 2 else {
      cancelPreview()
      return
    }
    schedulePreview(after: .zero)
  }

  public var seamFrames: [PanoSourceFrame] {
    if !stitcher.runsInDeviceMemory { return lastPreview?.sourceFrames ?? [] }
    return PanoSourceOrder.frames(previewAssets).map {
      PanoSourceFrame(assetId: $0.id.uuidString, path: $0.primaryURL?.path ?? $0.displayName)
    }
  }

  public var seamAuthoringDisabledReason: String? {
    if options.strategy == .tile { return "Seam constraints require Rotation or Auto, not Tile." }
    if options.boundaryWarp != 0 {
      return "Set Boundary Warp to zero before painting seam regions."
    }
    if isRunning || isPreviewing { return "Wait for the current panorama operation to finish." }
    guard lastPreview != nil, memoryFitOptions == options.withoutEdges, previewBoundaryWarp == 0
    else {
      return "Wait for a preview of the current frames and geometry."
    }
    if !stitcher.runsInDeviceMemory,
      seamFrames.isEmpty || seamFrames.count != previewAssets.count
    {
      return "This server must report every preview source frame before seam regions can be edited."
    }
    return nil
  }

  public var seamAuthoringAvailable: Bool { seamAuthoringDisabledReason == nil }

  public func setSeamConstraints(_ request: SeamConstraintsRequest?) {
    guard !isRunning, request == nil || seamAuthoringAvailable else { return }
    options.seamConstraints = request
  }

  public func previewSeamConstraints() {
    guard !isRunning, previewAssets.count >= 2 else { return }
    schedulePreview(after: .zero)
  }

  private func schedulePreview(after delay: Duration) {
    rePreviewWhenCurrentFinishes = false
    let superseded = previewTask
    superseded?.cancel()
    let unwinding = [superseded, runTask].compactMap { $0 }
    previewGeneration &+= 1
    let gen = previewGeneration
    let assets = previewAssets
    let capturedStitcher = stitcher
    previewState = delay == .zero ? .running(stage: .decoding, overallFraction: 0) : .scheduled

    previewTask = Task { [weak self] in
      for task in unwinding { await task.value }
      if delay > .zero {
        do { try await Task.sleep(for: delay) } catch { return }
      }
      guard let self, self.previewGeneration == gen else { return }
      let capturedOptions = self.options
      self.previewRunStrategy = capturedOptions.strategy
      self.previewState = .running(stage: .decoding, overallFraction: 0)
      do {
        let preview = try await capturedStitcher.preview(
          assets: assets,
          options: capturedOptions,
          alignment: self.alignment,
          progress: { [weak self] stage, stageFraction in
            guard let self, self.previewGeneration == gen else { return }
            let overall = PanoProgressWeights.preview.overall(
              stage: stage, stageFraction: stageFraction)
            self.previewState = .running(stage: stage, overallFraction: overall)
          }
        )
        let space = await self.readFreeSpace(capturedStitcher, assets)
        guard self.previewGeneration == gen else { return }
        try self.adopt(preview, of: assets, solvedFor: capturedOptions, space: space)
        self.previewIsEdgesOnly = false
        self.previewState = .ready
      } catch is CancellationError {
        return
      } catch {
        guard self.previewGeneration == gen else { return }
        if case PanoStitcherError.staleSeamGeometry = error {
          self.options.seamConstraints = nil
          self.memoryFitOptions = nil
        }
        self.previewIsEdgesOnly = false
        self.previewState = .failed(StitchError(underlying: error))
      }
      if self.rePreviewWhenCurrentFinishes {
        self.schedulePreview(after: .zero)
      }
    }
  }

  /// Volume queries can stall on a network share, so they stay off the
  /// main actor.
  private func readFreeSpace(_ stitcher: any PanoStitching, _ assets: [AssetRef]) async
    -> PanoFreeSpace?
  {
    guard stitcher.runsInDeviceMemory else { return nil }
    let freeSpace = self.freeSpace
    return await Task.detached(priority: .userInitiated) { freeSpace(stitcher, assets) }.value
  }

  private func adopt(
    _ preview: PanoPreview, of assets: [AssetRef], solvedFor options: PanoOptions,
    space: PanoFreeSpace?
  ) throws {
    let staleAlignment: Bool
    if case .stale = preview.alignmentOutcome {
      staleAlignment = true
    } else {
      staleAlignment = false
    }
    if options.seamConstraints != nil,
      staleAlignment
        || (!stitcher.runsInDeviceMemory
          && (preview.sourceFrames != lastPreview?.sourceFrames
            || preview.sourceFrames?.count != assets.count))
    {
      self.options.seamConstraints = nil
      memoryFitOptions = nil
      throw PanoStitcherError.staleSeamGeometry
    }
    alignment = preview.alignment
    alignmentFrames = assets.map(\.id)
    lastPreview = preview
    previewBoundaryWarp = options.boundaryWarp
    memoryFit = preview.stitchSizes.flatMap {
      memoryModel.fit(sizes: $0, availableBytes: availableMemory())
    }
    diskFit = preview.stitchSizes.flatMap {
      diskModel.fit(sizes: $0, space: space)
    }
    memoryFitOptions = options.withoutEdges
  }

  /// On a device with a per-process memory limit, the stitch must not size
  /// itself from a fit solved for other options: a `.fullFits` from them
  /// would pass no cap at all, and a fitted cap budgets their canvas's
  /// width. The same holds for the storage fit, whose PNG grows with the
  /// canvas. A stitch that runs elsewhere has no such limit to fit.
  private func needsFreshFit(for options: PanoOptions) -> Bool {
    stitcher.runsInDeviceMemory && memoryFitOptions != options.withoutEdges
      && (availableMemory() != nil || diskFit != nil)
  }

  private func pauseBackgroundWork(for stitcher: any PanoStitching) async -> PanoBackgroundPause? {
    guard stitcher.runsInDeviceMemory else { return nil }
    return await backgroundPause?.pause()
  }

  /// The sheet read the available memory while the backup was still running.
  /// Once it has stopped, the default output size is re-decided from the
  /// same preview against what the OS now grants. An explicit choice stands.
  private func refreshMemoryFit() {
    guard chosenOutputSize == nil, let options = memoryFitOptions,
      let sizes = lastPreview?.stitchSizes
    else { return }
    memoryFit = memoryModel.fit(sizes: sizes, availableBytes: availableMemory())
    memoryFitOptions = options
  }

  /// The running preview whose alignment Create Panorama should wait for:
  /// one already matching for the current geometry. A pending (debounced)
  /// re-preview has nothing in flight worth keeping.
  private var previewWorthAwaiting: Task<Void, Never>? {
    guard case .running = previewState, previewRunStrategy == options.strategy else { return nil }
    return previewTask
  }

  private func cancelPreview() {
    rePreviewWhenCurrentFinishes = false
    previewIsEdgesOnly = false
    previewGeneration &+= 1
    previewTask?.cancel()
    previewState = .idle
  }

  // MARK: - Stitch API

  /// Start the full stitch with the given ordered asset list, offering the
  /// preview's alignment. A preview already matching for the current
  /// geometry is waited for (`.finishingAlignment`) so its matching is not
  /// thrown away; a pending re-preview is cancelled. A finished preview
  /// stays visible.
  ///
  /// A run already in flight is cancelled first, and the new one waits for
  /// it and any cancelled preview to unwind before stitching, so the
  /// cancelled run's state never overwrites the new run's and two stitches
  /// never run at once.
  public func start(assets: [AssetRef]) {
    guard assets.count >= 2 else { return }
    if let reason = stitchBlockedReason {
      state = .error(StitchError(message: reason))
      return
    }

    let awaitedPreview = previewWorthAwaiting
    rePreviewWhenCurrentFinishes = false
    if awaitedPreview == nil {
      if isPreviewing { cancelPreview() }
      stitcher.cancel()
    }
    runTask?.cancel()
    let unwinding = [runTask, previewTask].compactMap { $0 }

    runGeneration &+= 1
    let gen = runGeneration
    let capturedStitcher = stitcher
    let capturedOptions = options
    let weights = PanoProgressWeights.stitch(localAlign: capturedOptions.localAlign)

    stitchIncludesAlignment = awaitedPreview != nil
    state =
      awaitedPreview == nil
      ? .running(stage: .decoding, stageFraction: 0.0, overallFraction: 0.0)
      : .finishingAlignment

    runTask = Task {
      for task in unwinding { await task.value }
      guard runGeneration == gen else { return }
      let pause = await pauseBackgroundWork(for: capturedStitcher)
      defer { pause?.release() }
      guard runGeneration == gen else { return }
      do {
        if capturedOptions.seamConstraints != nil,
          capturedOptions.seamConstraints != options.seamConstraints
        {
          throw PanoStitcherError.staleSeamGeometry
        }
        if pause?.stoppedRunningWork == true { refreshMemoryFit() }
        if needsFreshFit(for: capturedOptions) {
          stitchIncludesAlignment = true
          state = .finishingAlignment
          freshAlignmentFraction = 0
          defer { freshAlignmentFraction = nil }
          let preview = try await capturedStitcher.preview(
            assets: assets, options: capturedOptions, alignment: alignment,
            progress: { stage, stageFraction in
              guard self.runGeneration == gen else { return }
              self.freshAlignmentFraction = PanoProgressWeights.preview.overall(
                stage: stage, stageFraction: stageFraction)
            })
          let space = await readFreeSpace(capturedStitcher, assets)
          guard runGeneration == gen else { return }
          try adopt(preview, of: assets, solvedFor: capturedOptions, space: space)
          previewState = .ready
        }
        state = .running(stage: .decoding, stageFraction: 0.0, overallFraction: 0.0)
        let result = try await capturedStitcher.stitch(
          assets: assets,
          options: capturedOptions,
          alignment: alignment,
          maxCanvasPixels: outputCanvasCap,
          progress: { stage, stageFraction in
            guard self.runGeneration == gen else { return }
            self.state = .running(
              stage: stage,
              stageFraction: stageFraction,
              overallFraction: weights.overall(stage: stage, stageFraction: stageFraction)
            )
          }
        )
        guard runGeneration == gen else { return }
        if capturedOptions.seamConstraints != nil, case .stale = result.alignmentOutcome {
          throw PanoStitcherError.staleSeamGeometry
        }
        state = .done(result: result)
      } catch is CancellationError {
        // Superseded by a later `start` or `cancel()`, which already
        // set its own state.
      } catch {
        guard runGeneration == gen else { return }
        if case PanoStitcherError.staleSeamGeometry = error {
          options.seamConstraints = nil
          memoryFitOptions = nil
        }
        state = .error(StitchError(underlying: error))
      }
    }
  }

  /// Run later previews and stitches with `stitcher` — the merge sheet's
  /// "Run on server" choice (#5488). Whatever is in flight stops, and the
  /// alignment is dropped: one stitcher cannot reuse another's.
  public func use(_ stitcher: any PanoStitching) {
    guard stitcher !== self.stitcher else { return }
    let assets = previewAssets
    cancel()
    alignment = nil
    options.seamConstraints = nil
    self.stitcher = stitcher
    preview(assets: assets)
  }

  /// Cancel the in-flight stitch and preview and return to idle. The
  /// alignment is kept so reopening the same frames can reuse it.
  public func cancel() {
    runGeneration &+= 1  // invalidate the in-flight progress callbacks
    runTask?.cancel()
    stitcher.cancel()
    state = .idle
    previewAssets = []
    lastPreview = nil
    memoryFit = nil
    options.seamConstraints = nil
    diskFit = nil
    cancelPreview()
    stitcher.discardPreviewCache()
  }

  /// Stop the in-flight work and surface `message` as the run's failure, for
  /// an end the user did not ask for (the system expiring a background task).
  @discardableResult
  public func abort(because message: String) -> Bool {
    guard isRunning else { return false }
    runGeneration &+= 1
    runTask?.cancel()
    stitcher.cancel()
    cancelPreview()
    state = .error(StitchError(message: message))
    return true
  }

  /// The system warned that memory is low (#2037). Where the OS ends a
  /// process over its memory limit, a stitch or preview running here stops
  /// with a message instead of the app being terminated mid-run.
  public func handleMemoryPressure() {
    guard stitcher.runsInDeviceMemory, availableMemory() != nil else { return }
    let stopped = StitchError(underlying: PanoStitcherError.stoppedForMemory)
    if isRunning {
      abort(because: stopped.message)
    } else if isPreviewing {
      cancelPreview()
      previewState = .failed(stopped)
    }
  }

  /// Reset to idle after a done/error state so the user can adjust options
  /// and start again.
  public func reset() {
    guard !isRunning else { return }
    state = .idle
  }
}
