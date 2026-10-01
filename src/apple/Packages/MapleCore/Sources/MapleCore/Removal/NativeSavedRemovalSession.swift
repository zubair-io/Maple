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
/// Live GPU slider/tile integration is tracked separately under #3955.
public actor NativeSavedRemovalSession {
  private let handle: MapleRawHandle
  private var owner: SavedRemovalOwner?

  public init(handle: MapleRawHandle) { self.handle = handle }

  public func reset() { owner = nil }

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
