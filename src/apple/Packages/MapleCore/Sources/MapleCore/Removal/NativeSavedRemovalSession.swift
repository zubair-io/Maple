// Verified saved inspection/export on the retained RAW (#3955).
import Foundation
import RawPipeline

/// RGB8 sRGB preview or encoded export, copied out of the Rust allocator.
public struct NativeRemovalRender: Sendable {
  public let width: UInt32
  public let height: UInt32
  public let bytes: Data
}

private final class SavedRemovalOwner: @unchecked Sendable {
  let pointer: UnsafeMutablePointer<MapleSavedRemovals>
  init(_ pointer: UnsafeMutablePointer<MapleSavedRemovals>) { self.pointer = pointer }
  deinit { maple_removal_saved_close(pointer) }
}

/// Serializes the lifetime of an immutable accepted stack on an already decoded
/// RAW. Asset I/O belongs to the store; this session verifies a complete bundle
/// once and retains original bytes for Auto fitting. Cold calls run off main.
/// Native detail retains full-frame anchors between pans. Normal editor/GPU
/// integration is tracked separately under #3955 / #3984.
public actor NativeSavedRemovalSession {
  private let handle: MapleRawHandle
  private var owner: SavedRemovalOwner?

  public init(handle: MapleRawHandle) { self.handle = handle }

  public func reset() { owner = nil }

  /// Source-bound generation context includes previously accepted pixels.
  public func generationContext(
    xmp: String, x: UInt32, y: UInt32, width: UInt32, height: UInt32,
    cancel: CancelFlag? = nil
  ) throws -> [Float] {
    try Task.checkCancellation()
    try Self.requireCString(xmp)
    guard let owner, width > 0, height > 0, width <= 2048, height <= 2048 else {
      throw RemovalError.invalid("Saved removal context is unprepared or has invalid extent")
    }
    let count = Int(width) * Int(height) * 3
    var output = [Float](repeating: 0, count: count)
    var length: UInt = 0
    let rc = withExtendedLifetime((handle, owner, cancel)) {
      xmp.withCString { xmp in
        output.withUnsafeMutableBufferPointer {
          maple_removal_saved_context_f32(
            handle.pointer, owner.pointer, xmp, x, y, width, height,
            cancel?.pointer, $0.baseAddress, UInt(count), &length)
        }
      }
    }
    if rc == 20 { throw PipelineError.cancelled }
    try Self.check(rc)
    try Task.checkCancellation()
    guard length == UInt(count) else {
      throw RemovalError.invalid("Saved context dimensions changed")
    }
    return output
  }

  /// Returns ordered indices needing dependency review. A failed preparation
  /// clears the previous stack; it cannot leave another photo's result usable.
  public func prepare(source: Data, ext: String, xmp: String, assets: [String: Data]) throws
    -> [Int]
  {
    owner = nil
    try Task.checkCancellation()
    try Self.requireCString(ext)
    try Self.requireCString(xmp)
    let names = assets.keys.sorted()
    let entries = names.map { ["name": $0, "length": assets[$0]!.count] as [String: Any] }
    let manifest = String(
      decoding: try JSONSerialization.data(withJSONObject: entries), as: UTF8.self)
    var companions = Data()
    for name in names { companions.append(assets[name]!) }
    var pointer: UnsafeMutablePointer<MapleSavedRemovals>?
    let rc = withExtendedLifetime(handle) {
      xmp.withCString { xmp in
        manifest.withCString { manifest in
          ext.withCString { ext in
            companions.withUnsafeBytes { companions in
              source.withUnsafeBytes { sourceBytes in
                maple_removal_saved_open(
                  handle.pointer, xmp, manifest,
                  companions.bindMemory(to: UInt8.self).baseAddress, UInt(companions.count),
                  sourceBytes.bindMemory(to: UInt8.self).baseAddress, UInt(source.count), ext,
                  &pointer)
              }
            }
          }
        }
      }
    }
    try Self.check(rc)
    guard let pointer else { throw RemovalError.invalid("Missing saved removal owner") }
    let prepared = SavedRemovalOwner(pointer)
    let review = try withExtendedLifetime(prepared) {
      try RemovalBridge.buffer { output, cap, length in
        maple_removal_saved_review_buf(prepared.pointer, output, cap, length)
      }
    }
    let indices = try JSONDecoder().decode([Int].self, from: review)
    try Task.checkCancellation()
    owner = prepared
    return indices
  }

  /// Fixed As-Shot, unwarped, unoriented DefaultCrop RGB8 for selection.
  /// Includes accepted pixels but excludes creative grade, lens and crop; the
  /// shared Auto view is retained. Use only off main when preparing AI inputs.
  public func selectionProxy(xmp: String) throws -> NativeRemovalRender {
    try render(xmp: xmp, film: Data()) { owner, xmp, _, output in
      maple_removal_saved_selection_proxy(handle.pointer, owner.pointer, xmp, output)
    }
  }

  /// Returns packed RGB8 for the existing sRGB image presentation boundary.
  /// Cancellation discards completed output; it does not interrupt CPU render.
  public func preview(xmp: String, maxLongEdge: UInt32, film: Data = Data()) throws
    -> NativeRemovalRender
  {
    try render(xmp: xmp, film: film) { owner, xmp, filmBytes, output in
      maple_removal_saved_preview(
        handle.pointer, owner.pointer, xmp, maxLongEdge,
        filmBytes.bindMemory(to: UInt8.self).baseAddress, UInt(filmBytes.count), output)
    }
  }

  /// Packed sRGB native pixels in oriented DefaultCrop-relative coordinates.
  /// The bounded base supplies shared full-frame AE/Whites/Auto anchors; pans
  /// reuse them until XMP, base cap/quality or film changes. Filter overlap is
  /// included in the working-pixel limit (at most 8 Mi pixels). Unsupported
  /// stages or geometry throw; retain a verified sized preview on failure.
  /// Cancellation discards output, without interrupting a completed C render.
  public func detail(
    xmp: String, x: UInt32, y: UInt32, width: UInt32, height: UInt32,
    baseLongEdge: UInt32, previewBase: Bool = false, film: Data = Data(),
    maxWorkingPixels: UInt64 = 8 * 1024 * 1024
  ) throws -> NativeRemovalRender {
    try render(xmp: xmp, film: film) { owner, xmp, filmBytes, output in
      maple_removal_saved_detail(
        handle.pointer, owner.pointer, xmp, x, y, width, height, baseLongEdge,
        previewBase ? 1 : 0, filmBytes.bindMemory(to: UInt8.self).baseAddress,
        UInt(filmBytes.count), maxWorkingPixels, output)
    }
  }

  /// Shared export JSON: format, quality, color_space and max_long_edge.
  /// Returns ICC-tagged container bytes; writing a destination remains the
  /// export coordinator's responsibility, with its existing access grants.
  public func export(xmp: String, optionsJSON: String, film: Data = Data()) throws
    -> NativeRemovalRender
  {
    try Self.requireCString(optionsJSON)
    return try optionsJSON.withCString { request in
      try render(xmp: xmp, film: film) { owner, xmp, filmBytes, output in
        maple_removal_saved_export(
          handle.pointer, owner.pointer, xmp, request,
          filmBytes.bindMemory(to: UInt8.self).baseAddress, UInt(filmBytes.count), output)
      }
    }
  }

  private func render(
    xmp: String, film: Data,
    call: (
      SavedRemovalOwner, UnsafePointer<CChar>, UnsafeRawBufferPointer,
      UnsafeMutablePointer<MapleRemovalBuffer>
    ) -> Int32
  ) throws -> NativeRemovalRender {
    try Task.checkCancellation()
    try Self.requireCString(xmp)
    guard let owner else { throw RemovalError.invalid("Saved removals have not been prepared") }
    var output = MapleRemovalBuffer(bytes: nil, len: 0, width: 0, height: 0)
    defer { maple_removal_saved_free_buffer(&output) }
    let rc = withExtendedLifetime((handle, owner)) {
      xmp.withCString { xmp in
        film.withUnsafeBytes { call(owner, xmp, $0, &output) }
      }
    }
    try Self.check(rc)
    try Task.checkCancellation()
    guard let bytes = output.bytes, let count = Int(exactly: output.len), count > 0,
      output.width > 0, output.height > 0
    else { throw RemovalError.invalid("Invalid saved removal render output") }
    return NativeRemovalRender(
      width: output.width, height: output.height, bytes: Data(bytes: bytes, count: count))
  }

  private static func requireCString(_ string: String) throws {
    guard !string.utf8.contains(0) else {
      throw RemovalError.invalid("Removal request contains NUL")
    }
  }

  private static func check(_ code: Int32) throws {
    guard code != 0 else { return }
    throw RemovalError.invalid(
      maple_last_error().map { String(cString: $0) } ?? "Saved removal failed (\(code))")
  }
}
