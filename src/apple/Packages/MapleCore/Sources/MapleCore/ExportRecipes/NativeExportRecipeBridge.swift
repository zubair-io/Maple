import Foundation
import RawPipeline

/// The existing shared recipe/filename/encoder contracts; no native color-policy copy (#4113).
public enum NativeExportRecipeBridge {
  public static func json(_ recipe: ExportRecipe) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return String(decoding: try encoder.encode(recipe), as: UTF8.self)
  }

  public static func validate(_ recipe: ExportRecipe) throws {
    try json(recipe).withCString { pointer in
      guard maple_validate_export_recipe(pointer) == 0 else { throw failure() }
    }
  }

  public static func filename(
    _ recipe: ExportRecipe, stem: String, capturedAt: String?, index: UInt64
  ) throws -> String {
    let encoded = try json(recipe)
    var buffer = [UInt8](repeating: 0, count: 4096)
    var length: UInt = 0
    let result = encoded.withCString { config in
      stem.withCString { name in
        buffer.withUnsafeMutableBufferPointer { bytes in
          if let capturedAt {
            return capturedAt.withCString { date in
              maple_export_recipe_filename_buf(
                config, name, date, index, bytes.baseAddress, UInt(bytes.count), &length)
            }
          }
          return maple_export_recipe_filename_buf(
            config, name, nil, index, bytes.baseAddress, UInt(bytes.count), &length)
        }
      }
    }
    guard result == 0 else { throw failure() }
    guard length <= buffer.count,
      let name = String(bytes: buffer.prefix(Int(length)), encoding: .utf8),
      !name.isEmpty, name == URL(fileURLWithPath: name).lastPathComponent, !name.contains("/")
    else { throw NativeExportError.message("The naming template did not produce a safe filename.") }
    return name
  }

  static func render(
    source: URL, xmp: String, recipe: ExportRecipe, filmDirectory: URL?, staging: URL
  ) throws {
    let encoded = try json(recipe)
    let result = source.path.withCString { path in
      xmp.withCString { xml in
        encoded.withCString { config in
          staging.path.withCString { output in
            if let filmDirectory {
              return filmDirectory.path.withCString { film in
                maple_export_recipe_to_file(path, xml, config, film, output)
              }
            }
            return maple_export_recipe_to_file(path, xml, config, nil, output)
          }
        }
      }
    }
    guard result == 0 else { throw failure() }
  }

  private static func failure() -> NativeExportError {
    let message =
      maple_last_error().map { String(cString: $0) } ?? "The shared recipe encoder failed."
    return .message(message)
  }
}

public enum NativeExportError: LocalizedError, Sendable {
  case message(String)
  public var errorDescription: String? {
    switch self {
    case .message(let text): return text
    }
  }
}
