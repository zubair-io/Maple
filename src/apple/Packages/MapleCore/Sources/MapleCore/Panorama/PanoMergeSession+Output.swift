// PanoMergeSession+Output.swift — what the next stitch may produce on this
// device: the output size on offer, and whether it may run at all.

extension PanoMergeSession {
  /// The smaller output on offer: the tighter of what memory and storage
  /// allow. `nil` when full resolution fits both, or when either says no
  /// output size helps.
  public var fittedOutput: PanoFittedCanvas? {
    if case .tooLarge = memoryFit { return nil }
    if case .tooLarge = diskFit { return nil }
    let memory: PanoFittedCanvas? =
      if case .fitted(_, let canvas) = memoryFit { canvas } else { nil }
    let disk: PanoFittedCanvas? = if case .fitted(let canvas) = diskFit { canvas } else { nil }
    return [memory, disk].compactMap { $0 }.min { $0.pixels < $1.pixels }
  }

  /// The canvas cap the next stitch will run with, `nil` for the default.
  public var outputCanvasCap: Int? {
    guard outputSize == .fitted else { return nil }
    return fittedOutput?.pixels
  }

  /// Whether the frames alone need more memory than this device grants the
  /// app, at any output size, so the OS would end the app partway through
  /// the stitch. `start` re-reads the fit after pausing background work and
  /// refuses the stitch only if this still holds.
  public var stitchBlockedByMemory: Bool {
    guard stitcher.runsInDeviceMemory, case .tooLarge = memoryFit else { return false }
    return true
  }
}
