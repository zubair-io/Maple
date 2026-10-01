// Native inference consumer (#3941). Experimental CPU model; no UI release gate.
import Foundation
import RawPipeline

/// Retained native model. Open and generate off the main actor; Rust serializes
/// calls on this session. Inputs are prepared by the shared RAW encoding path.
public final class NativeRemovalReconstructor: @unchecked Sendable {
  fileprivate let pointer: UnsafeMutablePointer<MapleRemovalReconstructor>
  public let modelDigest: String

  private init(pointer: UnsafeMutablePointer<MapleRemovalReconstructor>, modelDigest: String) {
    self.pointer = pointer
    self.modelDigest = modelDigest
  }

  public static func open(directory: URL, runtime: URL? = nil) throws
    -> NativeRemovalReconstructor
  {
    guard directory.isFileURL, runtime?.isFileURL ?? true else {
      throw RemovalError.invalid("Removal models require local file URLs")
    }
    let directoryPath = directory.path
    let runtimePath = runtime?.path
    guard !directoryPath.contains("\0"), !(runtimePath?.contains("\0") ?? false) else {
      throw RemovalError.invalid("Invalid removal model path")
    }
    var pointer: UnsafeMutablePointer<MapleRemovalReconstructor>?
    let rc = directoryPath.withCString { directory in
      if let runtimePath {
        return runtimePath.withCString {
          maple_removal_reconstructor_open(directory, $0, &pointer)
        }
      }
      return maple_removal_reconstructor_open(directory, nil, &pointer)
    }
    try check(rc)
    guard let pointer else { throw RemovalError.invalid("Missing removal model handle") }
    do {
      let digest = try RemovalBridge.buffer { output, capacity, length in
        maple_removal_reconstructor_digest_buf(pointer, output, capacity, length)
      }
      return NativeRemovalReconstructor(
        pointer: pointer, modelDigest: String(decoding: digest, as: UTF8.self))
    } catch {
      maple_removal_reconstructor_close(pointer)
      throw error
    }
  }

  deinit { maple_removal_reconstructor_close(pointer) }

  public func operation() throws -> NativeRemovalInferenceOperation {
    var operation: UnsafeMutablePointer<MapleRemovalInference>?
    let rc = withExtendedLifetime(self) { maple_removal_inference_new(pointer, &operation) }
    try Self.check(rc)
    guard let operation else { throw RemovalError.invalid("Missing removal operation handle") }
    return NativeRemovalInferenceOperation(owner: self, pointer: operation)
  }

  /// Native 1024² CHW photographic RGB [0,1] and shared binary generation hole.
  /// This produces a proposal; it does not persist edits. The editor must guard
  /// its generation/revision before publishing a result or accepting a patch.
  public func generate(
    rgb: [Float], hole: [Float], operation: NativeRemovalInferenceOperation
  ) throws -> [Float] {
    let plane = 1024 * 1024
    guard operation.owner === self, rgb.count == 3 * plane, hole.count == plane else {
      throw RemovalError.invalid("Removal inference input or owner mismatch")
    }
    var output = [Float](repeating: 0, count: 3 * plane)
    var length: UInt = 0
    let rc = withExtendedLifetime((self, operation)) {
      rgb.withUnsafeBufferPointer { rgb in
        hole.withUnsafeBufferPointer { hole in
          output.withUnsafeMutableBufferPointer { output in
            maple_removal_reconstruct_f32(
              pointer, operation.pointer, rgb.baseAddress, UInt(rgb.count), hole.baseAddress,
              UInt(hole.count), output.baseAddress, UInt(output.count), &length)
          }
        }
      }
    }
    if rc == 20 { throw PipelineError.cancelled }
    try Self.check(rc)
    guard length == UInt(3 * plane) else {
      throw RemovalError.invalid("Removal inference output size mismatch")
    }
    return output
  }

  private static func check(_ code: Int32) throws {
    guard code != 0 else { return }
    throw RemovalError.invalid(
      maple_last_error().map { String(cString: $0) } ?? "Removal inference failed (\(code))")
  }
}

/// One generation's cancellation flag; retain until generation and cancel return.
public final class NativeRemovalInferenceOperation: @unchecked Sendable {
  let owner: AnyObject
  let pointer: UnsafeMutablePointer<MapleRemovalInference>

  init(
    owner: AnyObject, pointer: UnsafeMutablePointer<MapleRemovalInference>
  ) {
    self.owner = owner
    self.pointer = pointer
  }

  public func cancel() {
    withExtendedLifetime(self) { maple_removal_inference_cancel(pointer) }
  }

  deinit { maple_removal_inference_free(pointer) }
}
