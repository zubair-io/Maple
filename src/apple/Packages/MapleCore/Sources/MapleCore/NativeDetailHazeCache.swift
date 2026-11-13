import CoreImage
import Foundation

/// The native-detail patch's dehaze maps (#3287, #5215), kept per decoded
/// frame, prescale target and haze key so pans and dehaze-slider moves at
/// 100% neither copy the frame nor hand it to Rust again. One entry: a
/// native-detail session works on one frame. The frame is held weakly, so
/// the cache never keeps a released decode alive, and a freed frame can only
/// miss.
final class NativeDetailHazeCache: @unchecked Sendable {
  static let shared = NativeDetailHazeCache()

  private struct Entry {
    weak var frame: CIImage?
    let targetSize: CGSize?
    let key: UInt64
    let map: PipelineRenderer.HazeMap?
  }

  private let lock = NSLock()
  private var entry: Entry?
  private var measured = 0
  /// How many lookups measured; tests assert a hit measures nothing.
  var measurements: Int { lock.withLock { measured } }

  /// The maps for `source` under `key`, measuring with `measure` on a miss.
  /// The lock is not held while measuring, so a superseded patch never
  /// blocks the next one; two concurrent misses both measure and the later
  /// store wins.
  func map(
    source: NativeDetailHazeSource, key: UInt64,
    measure: () throws -> PipelineRenderer.HazeMap?
  ) rethrows -> PipelineRenderer.HazeMap? {
    let cached: Entry? = lock.withLock {
      entry.flatMap {
        $0.frame === source.frame && $0.targetSize == source.targetSize && $0.key == key
          ? $0 : nil
      }
    }
    if let cached { return cached.map }
    let map = try measure()
    lock.withLock {
      measured += 1
      entry = Entry(frame: source.frame, targetSize: source.targetSize, key: key, map: map)
    }
    return map
  }
}

/// The buffer a native-detail patch measures its dehaze maps from (#5215):
/// the decoded `frame`, prescaled to `targetSize` (`nil` keeps it whole) —
/// the GPU-live canvas's upload while that canvas is on glass, the decoded
/// base otherwise.
struct NativeDetailHazeSource: Sendable {
  let frame: CIImage
  let targetSize: CGSize?

  var image: CIImage { ImageEditPipeline.prescaleForDisplay(frame, targetSize: targetSize) }
}
