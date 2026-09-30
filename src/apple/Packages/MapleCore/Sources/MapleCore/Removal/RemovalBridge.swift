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
    case .invalid(let message): return message
    case .missingCompanion(let name): return "Removal asset is missing: \(name)"
    case .saveConflict: return "The photo changed before this removal could be saved."
    }
  }
}

public enum RemovalBridge {
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

  private static func buffer(
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
