// Real native Smart paint inference (#3941/#3942). CPU qualification stage.
import Foundation
import RawPipeline

/// Immutable source-context embedding. Keeps its model alive until all refine
/// calls finish. Source/window changes require a new embedding.
public final class NativeRemovalEmbedding: @unchecked Sendable {
  fileprivate let owner: NativeRemovalSelector
  fileprivate let pointer: UnsafeMutablePointer<MapleRemovalEmbedding>
  fileprivate init(
    owner: NativeRemovalSelector, pointer: UnsafeMutablePointer<MapleRemovalEmbedding>
  ) {
    self.owner = owner
    self.pointer = pointer
  }
  deinit { maple_removal_embedding_free(pointer) }
}

/// Retained pinned MobileSAM encoder/decoder. Rust serializes model calls;
/// invoke off main and guard source/selection revisions before publishing.
public final class NativeRemovalSelector: @unchecked Sendable {
  private let pointer: UnsafeMutablePointer<MapleRemovalSelector>
  private init(_ pointer: UnsafeMutablePointer<MapleRemovalSelector>) { self.pointer = pointer }
  deinit { maple_removal_selector_close(pointer) }

  public static func open(directory: URL, runtime: URL? = nil) throws -> NativeRemovalSelector {
    var pointer: UnsafeMutablePointer<MapleRemovalSelector>?
    let rc = try NativeSelectionBoundary.paths(directory: directory, runtime: runtime) {
      maple_removal_selector_open($0, $1, &pointer)
    }
    try NativeSelectionBoundary.check(rc)
    guard let pointer else { throw RemovalError.invalid("Missing removal selector") }
    return NativeRemovalSelector(pointer)
  }

  public func operation() throws -> NativeRemovalInferenceOperation {
    var operation: UnsafeMutablePointer<MapleRemovalInference>?
    let rc = withExtendedLifetime(self) {
      maple_removal_selector_operation_new(pointer, &operation)
    }
    try NativeSelectionBoundary.check(rc)
    guard let operation else { throw RemovalError.invalid("Missing selection operation") }
    return NativeRemovalInferenceOperation(owner: self, pointer: operation)
  }

  /// CHW 1024² photographic RGB in 0..255, prepared by shared encoding.
  public func encode(
    source: String, request: String, rgb: [Float], operation: NativeRemovalInferenceOperation
  ) throws -> NativeRemovalEmbedding {
    guard operation.owner === self, rgb.count == 3 * 1024 * 1024 else {
      throw RemovalError.invalid("Selection inference input or owner mismatch")
    }
    try NativeSelectionBoundary.string(source)
    try NativeSelectionBoundary.string(request)
    var embedding: UnsafeMutablePointer<MapleRemovalEmbedding>?
    let rc = withExtendedLifetime((self, operation)) {
      source.withCString { source in
        request.withCString { request in
          rgb.withUnsafeBufferPointer {
            maple_removal_selector_encode(
              pointer, operation.pointer, source, request, $0.baseAddress, UInt($0.count),
              &embedding)
          }
        }
      }
    }
    try NativeSelectionBoundary.check(rc)
    guard let embedding else { throw RemovalError.invalid("Missing selection embedding") }
    return NativeRemovalEmbedding(owner: self, pointer: embedding)
  }

  /// Lossless MIMF intent after positive/negative prompt validation. Does not
  /// change the caller's prior selection if inference or validation fails.
  public func refine(
    source: String, request: String, embedding: NativeRemovalEmbedding,
    operation: NativeRemovalInferenceOperation
  ) throws -> Data {
    guard operation.owner === self, embedding.owner === self else {
      throw RemovalError.invalid("Selection embedding or operation owner mismatch")
    }
    try NativeSelectionBoundary.string(source)
    try NativeSelectionBoundary.string(request)
    return try withExtendedLifetime((self, operation, embedding)) {
      try source.withCString { source in
        try request.withCString { request in
          try NativeSelectionBoundary.output {
            maple_removal_selector_refine(
              pointer, operation.pointer, embedding.pointer, source, request, $0)
          }
        }
      }
    }
  }
}

/// Boundary helpers shared by the concrete selector and detector consumers.
enum NativeSelectionBoundary {
  static func paths(
    directory: URL, runtime: URL?,
    call: (UnsafePointer<CChar>, UnsafePointer<CChar>?) -> Int32
  ) throws -> Int32 {
    guard directory.isFileURL, runtime?.isFileURL ?? true else {
      throw RemovalError.invalid("Removal models require local file URLs")
    }
    try string(directory.path)
    if let runtime { try string(runtime.path) }
    return directory.path.withCString { directory in
      if let runtime { return runtime.path.withCString { call(directory, $0) } }
      return call(directory, nil)
    }
  }

  static func string(_ value: String) throws {
    guard !value.utf8.contains(0) else {
      throw RemovalError.invalid("Removal request contains NUL")
    }
  }

  static func check(_ code: Int32) throws {
    if code == 20 { throw PipelineError.cancelled }
    guard code != 0 else { return }
    throw RemovalError.invalid(
      maple_last_error().map { String(cString: $0) } ?? "Selection inference failed (\(code))")
  }

  static func output(_ call: (UnsafeMutablePointer<MapleRemovalBuffer>) -> Int32) throws -> Data {
    var output = MapleRemovalBuffer(bytes: nil, len: 0, width: 0, height: 0)
    defer { maple_removal_saved_free_buffer(&output) }
    try check(call(&output))
    guard let bytes = output.bytes, let count = Int(exactly: output.len), count > 0 else {
      throw RemovalError.invalid("Invalid selection inference output")
    }
    return Data(bytes: bytes, count: count)
  }
}
