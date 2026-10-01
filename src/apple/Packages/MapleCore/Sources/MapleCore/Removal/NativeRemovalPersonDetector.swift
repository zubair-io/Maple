// Native person proposals (#3941). Role review/protection belongs to the editor.
import Foundation
import RawPipeline

public struct NativeRemovalDetection: Decodable, Sendable {
  public let `class`: UInt8
  /// x0,y0,x1,y1 in the supplied source's native pixel dimensions.
  public let bounds: [Float]
  public let score: Float
}

/// Retained pinned RT-DETR model. Invoke off main. These are proposals; detecting
/// every background person and protecting the main subject require review.
public final class NativeRemovalPersonDetector: @unchecked Sendable {
  private let pointer: UnsafeMutablePointer<MapleRemovalDetector>
  private init(_ pointer: UnsafeMutablePointer<MapleRemovalDetector>) { self.pointer = pointer }
  deinit { maple_removal_detector_close(pointer) }

  public static func open(directory: URL, runtime: URL? = nil) throws -> NativeRemovalPersonDetector
  {
    var pointer: UnsafeMutablePointer<MapleRemovalDetector>?
    let rc = try NativeSelectionBoundary.paths(directory: directory, runtime: runtime) {
      maple_removal_detector_open($0, $1, &pointer)
    }
    try NativeSelectionBoundary.check(rc)
    guard let pointer else { throw RemovalError.invalid("Missing person detector") }
    return NativeRemovalPersonDetector(pointer)
  }

  public func operation() throws -> NativeRemovalInferenceOperation {
    var operation: UnsafeMutablePointer<MapleRemovalInference>?
    let rc = withExtendedLifetime(self) {
      maple_removal_detector_operation_new(pointer, &operation)
    }
    try NativeSelectionBoundary.check(rc)
    guard let operation else { throw RemovalError.invalid("Missing detection operation") }
    return NativeRemovalInferenceOperation(owner: self, pointer: operation)
  }

  /// CHW 640² photographic RGB in 0..1. Returns all 300 model proposals without
  /// silently choosing a subject, background role or selection threshold.
  public func detect(
    rgb: [Float], sourceWidth: UInt32, sourceHeight: UInt32,
    operation: NativeRemovalInferenceOperation
  ) throws -> [NativeRemovalDetection] {
    guard operation.owner === self, rgb.count == 3 * 640 * 640,
      sourceWidth > 0, sourceHeight > 0
    else { throw RemovalError.invalid("Detection input or owner mismatch") }
    let data = try withExtendedLifetime((self, operation)) {
      try rgb.withUnsafeBufferPointer { rgb in
        try NativeSelectionBoundary.output {
          maple_removal_detector_detect(
            pointer, operation.pointer, rgb.baseAddress, UInt(rgb.count), sourceWidth, sourceHeight,
            $0)
        }
      }
    }
    let proposals = try JSONDecoder().decode([NativeRemovalDetection].self, from: data)
    guard proposals.count == 300,
      proposals.allSatisfy({
        $0.class < 80 && $0.bounds.count == 4 && $0.bounds.allSatisfy(\.isFinite)
          && $0.score.isFinite && (0...1).contains($0.score)
      })
    else { throw RemovalError.invalid("Invalid person detection output") }
    return proposals
  }
}
