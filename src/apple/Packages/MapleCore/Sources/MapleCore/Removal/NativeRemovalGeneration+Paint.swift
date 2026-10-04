import Foundation
import RawPipeline

extension NativeRemovalGeneration {
  /// Shared complete-area grouping, only for manually painted intent. Every
  /// context is preflighted before the editor starts any reconstruction job.
  public static func paintIntents(
    source: String, intent: Data, holeRadius: UInt32, fringeRadius: Float
  ) throws -> [Data] {
    guard !source.utf8.contains(0) else {
      throw RemovalError.invalid("Removal source contains NUL")
    }
    let packed = try source.withCString { source in
      try intent.withUnsafeBytes { bytes in
        try RemovalBridge.buffer { output, capacity, length in
          maple_removal_paint_intents_buf(
            source, bytes.bindMemory(to: UInt8.self).baseAddress, UInt(intent.count),
            holeRadius, fringeRadius, output, capacity, length)
        }
      }
    }
    var cursor = 0
    func integer() throws -> Int {
      guard packed.count - cursor >= 4 else {
        throw RemovalError.invalid("Truncated painted-area framing")
      }
      let value = packed.withUnsafeBytes {
        UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: cursor, as: UInt32.self))
      }
      cursor += 4
      return Int(value)
    }
    let count = try integer()
    guard count > 0, count <= (packed.count - cursor) / 36 else {
      throw RemovalError.invalid("Invalid painted-area count")
    }
    let masks = try (0..<count).map { _ -> Data in
      let length = try integer()
      guard length >= 32, length <= packed.count - cursor else {
        throw RemovalError.invalid("Invalid painted-area length")
      }
      let bytes = packed.subdata(in: cursor..<cursor + length)
      cursor += length
      return bytes
    }
    guard cursor == packed.count else {
      throw RemovalError.invalid("Trailing painted-area data")
    }
    return masks
  }
}

extension NativeRemovalEditorEngine {
  func paintIntents(_ intent: Data, context: NativeRemovalEditorContext) throws -> [Data] {
    try Task.checkCancellation()
    let masks = try NativeRemovalGeneration.paintIntents(
      source: context.source, intent: intent, holeRadius: ExperimentalRemovalModels.holeRadius,
      fringeRadius: ExperimentalRemovalModels.fringeRadius)
    try Task.checkCancellation()
    return masks
  }
}
