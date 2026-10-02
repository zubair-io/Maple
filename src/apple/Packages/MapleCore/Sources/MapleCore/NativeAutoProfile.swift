// #1472: immutable native Auto tail shared by Mac live, CPU and export.
import CoreImage
import Foundation
import RawPipeline

struct AutoProfileArtifacts: Sendable {
  let curveFlat: [Float]?
  let lutSize: Int
  let lutData: [Float]?

  func withBuffers<T>(
    _ body: (UnsafeBufferPointer<Float>, UnsafeBufferPointer<Float>) throws -> T
  ) rethrows -> T {
    let curve = curveFlat ?? []
    let lut = lutData ?? []
    return try curve.withUnsafeBufferPointer { curve in
      try lut.withUnsafeBufferPointer { lut in try body(curve, lut) }
    }
  }
}

struct NativeAutoProfile: Sendable {
  let id = UUID()
  let artifacts: AutoProfileArtifacts?
}

/// Serializes the two actual native producers. A full export queued behind
/// preparation uses its Render(None) fit; an export first fills that same core
/// cache. Their multi-GB develop buffers never overlap with each other.
actor NativeAutoProfileWorker {
  static let shared = NativeAutoProfileWorker()

  func prepare(url: URL, quality: PipelineRenderer.Quality, cancel: CancelFlag) throws
    -> NativeAutoProfile
  {
    try Task.checkCancellation()
    defer { withExtendedLifetime(cancel) {} }
    var curve = [Float](repeating: 0, count: Int(MAPLE_PROFILE_CURVE_FLAT_LEN))
    var lut = [Float](repeating: 0, count: 49 * 49 * 49 * 3)
    var present: Int32 = 0
    var size: UInt32 = 0
    func call() -> Int32 {
      url.path.withCString { path in
        curve.withUnsafeMutableBufferPointer { c in
          lut.withUnsafeMutableBufferPointer { l in
            maple_prepare_native_auto_profile(
              path, quality.rawValue, c.baseAddress, &present, l.baseAddress, UInt(l.count),
              &size, cancel.pointer)
          }
        }
      }
    }
    let rc = call()
    if rc == 4 { throw CancellationError() }
    if rc == 1 { return NativeAutoProfile(artifacts: nil) }
    guard rc == 0 else {
      // No paths/pixels in default diagnostics; preparation failure is distinct
      // from a valid RAW with no embedded JPEG (which is cached as absent).
      throw NativeAutoProfileError.failed(rc)
    }
    let n = Int(size)
    return NativeAutoProfile(
      artifacts: AutoProfileArtifacts(
        curveFlat: present == 1 ? curve : nil, lutSize: n,
        lutData: n > 0 ? Array(lut.prefix(n * n * n * 3)) : nil))
  }

  func renderFullDisplay(
    raw: URL, xmp: URL, quality: PipelineRenderer.Quality, target: CanvasColorSpace,
    filmLut: (data: [Float], size: Int, key: UInt32)?
  ) throws -> CIImage {
    try Task.checkCancellation()
    return try PipelineRenderer.renderFullDisplay(
      rawPath: raw, xmpPath: xmp, quality: quality, target: target, filmLut: filmLut)
  }
}

enum NativeAutoProfileError: Error {
  case failed(Int32)
  case sourceChanged
}
