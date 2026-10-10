// Native context → prepared model → portable accepted assets (#3941 / #3955).
import Foundation
import RawPipeline

public struct NativeRemovalProposal: Sendable {
  public let request: String
  public let mask: Data
  public let patch: Data
}

/// Immutable shared preparation. Call off main; the editor must still guard its
/// image and selection revision before inspecting or publishing this proposal.
public final class NativeRemovalGeneration: @unchecked Sendable {
  private static let modelSide = Int(ExperimentalRemovalModels.lama.nativeSide)
  private let pointer: UnsafeMutablePointer<MapleRemovalGeneration>
  private let intent: Data

  private init(pointer: UnsafeMutablePointer<MapleRemovalGeneration>, intent: Data) {
    self.pointer = pointer
    self.intent = intent
  }

  deinit { maple_removal_generation_close(pointer) }

  public static func plan(source: String, intent: Data, holeRadius: UInt32, fringeRadius: Float)
    throws -> String
  {
    try requireCString(source)
    let data = try source.withCString { source in
      try intent.withUnsafeBytes { bytes in
        try RemovalBridge.buffer { output, capacity, length in
          maple_removal_generation_plan_buf(
            source, bytes.bindMemory(to: UInt8.self).baseAddress, UInt(intent.count),
            holeRadius, fringeRadius, output, capacity, length)
        }
      }
    }
    return String(decoding: data, as: UTF8.self)
  }

  public static func prepare(
    request: String, prior: String, scene: [Float], intent: Data,
    protected: Data = Data()
  ) throws -> NativeRemovalGeneration {
    try requireCString(request)
    try requireCString(prior)
    guard scene.count <= 3 * 2048 * 2048 else {
      throw RemovalError.invalid("Removal generation context exceeds 2048 pixels per axis")
    }
    var pointer: UnsafeMutablePointer<MapleRemovalGeneration>?
    let rc = request.withCString { request in
      prior.withCString { prior in
        scene.withUnsafeBufferPointer { scene in
          intent.withUnsafeBytes { intentBytes in
            protected.withUnsafeBytes { protectedBytes in
              maple_removal_generation_open(
                request, prior, scene.baseAddress, UInt(scene.count),
                intentBytes.bindMemory(to: UInt8.self).baseAddress, UInt(intent.count),
                protectedBytes.bindMemory(to: UInt8.self).baseAddress, UInt(protected.count),
                &pointer)
            }
          }
        }
      }
    }
    try check(rc)
    guard let pointer else { throw RemovalError.invalid("Missing prepared removal generation") }
    return NativeRemovalGeneration(pointer: pointer, intent: intent)
  }

  public func inputs() throws -> (rgb: [Float], hole: [Float]) {
    func values(kind: UInt32, count: Int) throws -> [Float] {
      var output = [Float](repeating: 0, count: count)
      var length: UInt = 0
      let rc = withExtendedLifetime(self) {
        output.withUnsafeMutableBufferPointer {
          maple_removal_generation_inputs_f32(pointer, kind, $0.baseAddress, UInt(count), &length)
        }
      }
      try Self.check(rc)
      guard length == UInt(count) else {
        throw RemovalError.invalid("Invalid prepared model tensor")
      }
      return output
    }
    return (
      try values(kind: 0, count: 3 * Self.modelSide * Self.modelSide),
      try values(kind: 1, count: Self.modelSide * Self.modelSide)
    )
  }

  public func finish(generated: [Float], cancel: CancelFlag? = nil) throws -> NativeRemovalProposal
  {
    let patch: Data
    do {
      patch = try withExtendedLifetime((self, cancel)) {
        try generated.withUnsafeBufferPointer { generated in
          try RemovalBridge.buffer { output, capacity, length in
            maple_removal_generation_finish_buf(
              pointer, generated.baseAddress, UInt(generated.count), cancel?.pointer,
              output, capacity, length)
          }
        }
      }
    } catch {
      if maple_last_error().map({ String(cString: $0) }) == "guided removal: cancelled" {
        throw PipelineError.cancelled
      }
      throw error
    }
    let metadata = try withExtendedLifetime(self) {
      try RemovalBridge.buffer { output, capacity, length in
        maple_removal_generation_request_buf(pointer, output, capacity, length)
      }
    }
    return NativeRemovalProposal(
      request: String(decoding: metadata, as: UTF8.self), mask: intent,
      patch: patch)
  }

  public func reconstruct(
    using model: NativeRemovalReconstructor,
    operation: NativeRemovalInferenceOperation,
    cancel: CancelFlag? = nil
  ) throws -> NativeRemovalProposal {
    let metadata = try withExtendedLifetime(self) {
      try RemovalBridge.buffer { output, capacity, length in
        maple_removal_generation_request_buf(pointer, output, capacity, length)
      }
    }
    let request = try JSONSerialization.jsonObject(with: metadata) as? [String: Any]
    guard request?["model"] as? String == model.modelDigest else {
      throw RemovalError.invalid("Prepared removal belongs to a different reconstruction model")
    }
    let input = try inputs()
    return try finish(
      generated: model.generate(rgb: input.rgb, hole: input.hole, operation: operation),
      cancel: cancel)
  }

  private static func requireCString(_ value: String) throws {
    guard !value.utf8.contains(0) else {
      throw RemovalError.invalid("Removal request contains NUL")
    }
  }

  private static func check(_ code: Int32) throws {
    guard code == 0 else {
      throw RemovalError.invalid(
        maple_last_error().map { String(cString: $0) } ?? "Removal generation failed (\(code))")
    }
  }
}
