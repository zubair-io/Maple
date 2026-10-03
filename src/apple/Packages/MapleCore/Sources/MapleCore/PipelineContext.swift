import CoreImage
import Foundation
import Metal

/// Per-pipeline Core Image context, allocated at first render rather than on
/// main-thread session creation. CIContext is thread safe; only creation needs
/// serialization because CPU rendering and GPU readback can enter together.
final class PipelineContext: @unchecked Sendable {
  private let lock = NSLock()
  private var context: CIContext?

  var isInitialized: Bool {
    lock.lock()
    defer { lock.unlock() }
    return context != nil
  }

  var value: CIContext {
    lock.lock()
    defer { lock.unlock() }
    if let context { return context }
    let created = Self.makeContext()
    context = created
    return created
  }

  private static func makeContext() -> CIContext {
    // Metal-backed context where available; `cacheIntermediates: false`
    // + f32 working format (#487) keeps memory bounded enough that
    // CoreImage can tile internally on a 100MP input while preserving
    // full scene-buffer precision through the chain. Migrated from
    // fp16 in #487 — see PipelineRenderer.applySceneLinearChain.
    if let device = MTLCreateSystemDefaultDevice() {
      return CIContext(
        mtlDevice: device,
        options: [
          .workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!,
          .workingFormat: CIFormat.RGBAf,
          .cacheIntermediates: false,
        ])
    } else {
      return CIContext(options: [
        .workingColorSpace: CGColorSpace(name: CGColorSpace.linearSRGB)!,
        .workingFormat: CIFormat.RGBAf,
        .cacheIntermediates: false,
      ])
    }
  }

}
