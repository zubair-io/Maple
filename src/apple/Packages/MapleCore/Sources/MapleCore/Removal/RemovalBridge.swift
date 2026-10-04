// Shared removal boundaries (#3940 / #1472). Wire format, rasterization,
// asset identities and codec verification remain in Rust.
import Foundation
import RawPipeline

public enum RemovalError: Error, LocalizedError {
  case invalid(String)
  case missingCompanion(String)
  case saveConflict

  public var errorDescription: String? {
    switch self {
    case .invalid(let message):
      if message == "smart selection: no candidate honors the positive and negative prompts"
        || message
          == "invalid removal input: smart selection: no candidate honors the positive and negative prompts"
      {
        return
          "Smart paint could not follow all of your strokes. Your selection is unchanged. Try another stroke or use Refine with Paint."
      }
      if message == "removal generation: selection and expansion exceed native context"
        || message
          == "removal generation: one connected painted area and its expansion exceed native context; refine that area before removing"
      {
        let side = ExperimentalRemovalModels.lama.nativeSide
        return
          "This object is too large for the current removal model. The selection and edge expansion must fit inside \(side) × \(side) source pixels. Select a smaller object."
      }
      return message
    case .missingCompanion(let name): return "Removal asset is missing: \(name)"
    case .saveConflict: return "The photo changed before this removal could be saved."
    }
  }
}

public enum RemovalBridge {
  static func refineSelection(_ base: Data, strokes: [RemovalStroke], protection: Data = Data())
    throws -> Data
  {
    struct Request: Encodable {
      let schema = 1
      let strokes: [RemovalStroke]
    }
    let json = String(
      decoding: try JSONEncoder().encode(Request(strokes: strokes)), as: UTF8.self)
    return try base.withUnsafeBytes { bytes in
      try protection.withUnsafeBytes { protected in
        try json.withCString { request in
          try buffer { output, capacity, length in
            maple_removal_refine_selection_buf(
              bytes.bindMemory(to: UInt8.self).baseAddress, UInt(base.count),
              protected.bindMemory(to: UInt8.self).baseAddress, UInt(protection.count), request,
              output, capacity, length)
          }
        }
      }
    }
  }

  /// Shared conservative subject/background/uncertain proposal policy. The
  /// returned Keep defaults remain editable and never publish an accepted edit.
  public static func peopleSuggestions(
    _ detections: [NativeRemovalDetection], width: UInt32, height: UInt32
  ) throws -> [RemovalPersonSuggestion] {
    struct Request: Encodable {
      let schema = 1
      let sourceWidth: UInt32
      let sourceHeight: UInt32
      let detections: [NativeRemovalDetection]
      enum CodingKeys: String, CodingKey {
        case schema, detections
        case sourceWidth = "source_width"
        case sourceHeight = "source_height"
      }
    }
    let json = String(
      decoding: try JSONEncoder().encode(
        Request(sourceWidth: width, sourceHeight: height, detections: detections)), as: UTF8.self)
    let data = try json.withCString { request in
      try buffer { output, capacity, length in
        maple_removal_people_suggestions_buf(request, output, capacity, length)
      }
    }
    return try JSONDecoder().decode([RemovalPersonSuggestion].self, from: data)
  }

  /// Shared union/subtraction for person masks and protected regions. Empty
  /// Data means no selection. Invalid geometry or assets throw without editing
  /// the caller's previous mask. Execute outside the slider/render loop.
  public static func combineMasks(_ left: Data, _ right: Data, subtract: Bool = false) throws
    -> Data
  {
    try left.withUnsafeBytes { leftBytes in
      try right.withUnsafeBytes { rightBytes in
        try buffer { output, capacity, length in
          maple_removal_combine_masks_buf(
            leftBytes.bindMemory(to: UInt8.self).baseAddress, UInt(left.count),
            rightBytes.bindMemory(to: UInt8.self).baseAddress, UInt(right.count),
            subtract ? 1 : 0, output, capacity, length)
        }
      }
    }
  }

  /// Binary intent pixels and native source-window geometry for overlays and
  /// selection extent checks. The same strict MIMF decoder verifies both calls.
  public static func decodeMask(_ mask: Data) throws -> NativeRemovalMask {
    var window = [UInt32](repeating: 0, count: 6)
    let pixels = try mask.withUnsafeBytes { bytes in
      try buffer { output, capacity, length in
        maple_removal_mask_decode_buf(
          bytes.bindMemory(to: UInt8.self).baseAddress, UInt(mask.count),
          output, capacity, length, &window)
      }
    }
    guard pixels.count == Int(window[4]) * Int(window[5]), !pixels.isEmpty else {
      throw RemovalError.invalid("Invalid removal mask extent")
    }
    return NativeRemovalMask(
      sourceWidth: window[0], sourceHeight: window[1], x: window[2], y: window[3],
      width: window[4], height: window[5], pixels: pixels)
  }

  public static func digest(_ data: Data) throws -> String {
    var output = [UInt8](repeating: 0, count: 71)
    let capacity = UInt(output.count)
    let rc = data.withUnsafeBytes { bytes in
      maple_removal_content_digest(
        bytes.bindMemory(to: UInt8.self).baseAddress, UInt(data.count), &output, capacity)
    }
    try check(rc)
    return String(decoding: output, as: UTF8.self)
  }

  public static func selection(width: UInt32, height: UInt32, request: String) throws -> Data {
    try requireCString(request)
    return try request.withCString { request in
      try buffer { output, cap, length in
        maple_removal_selection_buf(width, height, request, output, cap, length)
      }
    }
  }

  /// Prepare continuous add/erase gestures once, outside the live render loop.
  /// The immutable returned request identifies the model inference it belongs to.
  public static func smartStrokes(request: String) throws -> String {
    try requireCString(request)
    let data = try request.withCString { request in
      try buffer { output, cap, length in
        maple_removal_smart_strokes_buf(request, output, cap, length)
      }
    }
    return String(decoding: data, as: UTF8.self)
  }

  public static func smartPrompts(request: String) throws -> String {
    try requireCString(request)
    let data = try request.withCString { request in
      try buffer { output, cap, length in
        maple_removal_smart_prompts_buf(request, output, cap, length)
      }
    }
    return String(decoding: data, as: UTF8.self)
  }

  /// Reject nonfinite or prompt-violating output; callers retain their previous
  /// selection on failure. Run off the main actor after the model task completes.
  public static func smartMask(request: String, logits: [Float], scores: [Float]) throws -> Data {
    try requireCString(request)
    return try request.withCString { request in
      try logits.withUnsafeBufferPointer { logits in
        try scores.withUnsafeBufferPointer { scores in
          try buffer { output, cap, length in
            maple_removal_smart_mask_buf(
              request, logits.baseAddress, UInt(logits.count), scores.baseAddress,
              UInt(scores.count), output, cap, length)
          }
        }
      }
    }
  }

  /// One-shot native reconstruction hole then blend coverage. Each contiguous
  /// f32 plane has the context's pixel count; selection interiors stay opaque.
  public static func generationMasks(request: String, intent: Data, protected: Data = Data()) throws
    -> [Float]
  {
    try requireCString(request)
    return try request.withCString { request in
      try intent.withUnsafeBytes { intentBytes in
        try protected.withUnsafeBytes { protectedBytes in
          let call: (UnsafeMutablePointer<Float>?, UInt, UnsafeMutablePointer<UInt>) -> Int32 = {
            output, cap, length in
            maple_removal_generation_masks_f32(
              request, intentBytes.bindMemory(to: UInt8.self).baseAddress, UInt(intent.count),
              protectedBytes.bindMemory(to: UInt8.self).baseAddress, UInt(protected.count), output,
              cap, length)
          }
          var length: UInt = 0
          let probe = call(nil, 0, &length)
          guard probe == 100, let count = Int(exactly: length), count > 0 else {
            try check(probe)
            throw RemovalError.invalid("Invalid generation mask output length")
          }
          var output = [Float](repeating: 0, count: count)
          let capacity = length
          let rc = output.withUnsafeMutableBufferPointer { call($0.baseAddress, capacity, &length) }
          try check(rc)
          guard length == capacity else {
            throw RemovalError.invalid("Generation masks changed during preparation")
          }
          return output
        }
      }
    }
  }

  public static func prepare(request: String, prior: String, mask: Data, patch: Data) throws
    -> String
  {
    try requireCString(request)
    try requireCString(prior)
    let data = try request.withCString { request in
      try prior.withCString { prior in
        try mask.withUnsafeBytes { maskBytes in
          try patch.withUnsafeBytes { patchBytes in
            try buffer { output, cap, length in
              maple_removal_prepare_buf(
                request, prior, maskBytes.bindMemory(to: UInt8.self).baseAddress, UInt(mask.count),
                patchBytes.bindMemory(to: UInt8.self).baseAddress, UInt(patch.count), output, cap,
                length)
            }
          }
        }
      }
    }
    return String(decoding: data, as: UTF8.self)
  }

  public static func assetNames(records: String) throws -> [String] {
    try requireCString(records)
    let data = try records.withCString { records in
      try buffer { output, cap, length in
        maple_removal_asset_names_buf(records, output, cap, length)
      }
    }
    return try JSONDecoder().decode([String].self, from: data)
  }

  public static func savedList(records: String) throws -> [SavedRemovalEntry] {
    try requireCString(records)
    let data = try records.withCString { records in
      try buffer { output, capacity, length in
        maple_removal_saved_list_buf(records, output, capacity, length)
      }
    }
    return try JSONDecoder().decode([SavedRemovalEntry].self, from: data)
  }

  public static func savedPrefix(records: String, id: String) throws -> String {
    try requireCString(records)
    try requireCString(id)
    let data = try records.withCString { records in
      try id.withCString { id in
        try buffer { output, capacity, length in
          maple_removal_saved_prefix_buf(records, id, output, capacity, length)
        }
      }
    }
    return String(decoding: data, as: UTF8.self)
  }

  public static func savedEdit(
    records: String, id: String, action: SavedRemovalAction,
    active: Bool? = nil, replacement: String? = nil
  ) throws -> String {
    struct Request: Encodable {
      let schema = savedRemovalEditVersion
      let id: String
      let action: SavedRemovalAction
      let active: Bool?
      let replacement: String?
    }
    try requireCString(records)
    let request = String(
      decoding: try JSONEncoder().encode(
        Request(id: id, action: action, active: active, replacement: replacement)), as: UTF8.self)
    try requireCString(request)
    let data = try records.withCString { records in
      try request.withCString { request in
        try buffer { output, capacity, length in
          maple_removal_saved_edit_buf(records, request, output, capacity, length)
        }
      }
    }
    return String(decoding: data, as: UTF8.self)
  }

  public static func verifyAsset(name: String, data: Data) throws {
    try requireCString(name)
    let rc = name.withCString { name in
      data.withUnsafeBytes { bytes in
        maple_removal_asset_verify(
          name, bytes.bindMemory(to: UInt8.self).baseAddress, UInt(data.count))
      }
    }
    try check(rc)
  }

  public static func verifySource(records: String, rawURL: URL) throws {
    try requireCString(records)
    let original = try digest(Data(contentsOf: rawURL, options: .mappedIfSafe))
    let rc = records.withCString { records in
      original.withCString { original in
        maple_removal_source_verify(records, original)
      }
    }
    try check(rc)
  }

  static func buffer(
    _ call: (UnsafeMutablePointer<UInt8>?, UInt, UnsafeMutablePointer<UInt>) -> Int32
  ) throws -> Data {
    var length: UInt = 0
    let probe = call(nil, 0, &length)
    if probe == 0 && length == 0 { return Data() }
    guard probe == 100, let count = Int(exactly: length) else {
      try check(probe)
      throw RemovalError.invalid("Invalid removal output length")
    }
    let capacity = length
    var data = Data(count: count)
    let rc = data.withUnsafeMutableBytes { bytes in
      call(bytes.bindMemory(to: UInt8.self).baseAddress, capacity, &length)
    }
    try check(rc)
    guard length == UInt(count) else {
      throw RemovalError.invalid("Removal output changed during preparation")
    }
    return data
  }

  private static func requireCString(_ value: String) throws {
    guard !value.utf8.contains(0) else {
      throw RemovalError.invalid("Removal request contains a NUL byte")
    }
  }

  private static func check(_ code: Int32) throws {
    guard code != 0 else { return }
    throw RemovalError.invalid(
      maple_last_error().map { String(cString: $0) } ?? "Removal operation failed (\(code))")
  }
}

public struct NativeRemovalMask: Sendable {
  public let sourceWidth: UInt32
  public let sourceHeight: UInt32
  public let x: UInt32
  public let y: UInt32
  public let width: UInt32
  public let height: UInt32
  public let pixels: Data
}
