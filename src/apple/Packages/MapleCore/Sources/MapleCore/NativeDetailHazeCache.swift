import CoreImage
import Foundation

/// The native-detail patch's dehaze maps (#3287), kept per decoded frame and
/// haze key so pans and dehaze-slider moves at 100% neither copy the frame
/// nor hand it to Rust again. One entry: a native-detail session works on one
/// frame. The frame is held weakly, so the cache never keeps a released
/// decode alive, and a freed frame can only miss.
final class NativeDetailHazeCache: @unchecked Sendable {
  static let shared = NativeDetailHazeCache()

  private struct Entry {
    weak var frame: CIImage?
    let key: UInt64
    let map: PipelineRenderer.HazeMap?
  }

  private let lock = NSLock()
  private var entry: Entry?
  #if DEBUG
    private var measured = 0
    var measurements: Int { lock.withLock { measured } }
  #endif

  /// The maps for `frame` under `key`, measuring with `measure` on a miss.
  /// The lock is not held while measuring, so a superseded patch never
  /// blocks the next one; two concurrent misses both measure and the later
  /// store wins.
  func map(
    frame: CIImage, key: UInt64, measure: () throws -> PipelineRenderer.HazeMap?
  ) rethrows -> PipelineRenderer.HazeMap? {
    let cached: Entry? = lock.withLock {
      entry.flatMap { $0.frame === frame && $0.key == key ? $0 : nil }
    }
    if let cached { return cached.map }
    let map = try measure()
    lock.withLock {
      #if DEBUG
        measured += 1
      #endif
      entry = Entry(frame: frame, key: key, map: map)
    }
    return map
  }
}
