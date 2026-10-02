// The shared Rust workflow validator/converter; no filesystem I/O (#4036).
import Foundation
import RawPipeline

public struct WorkflowSidecarError: Error, LocalizedError {
  public let message: String
  public var errorDescription: String? { message }
}
public enum WorkflowSidecarCore {
  public static func read(xmp: String) throws -> SidecarWorkflow? {
    let json = try convert(json: nil, xmp: xmp)
    return try JSONDecoder().decode(SidecarWorkflow?.self, from: Data(json.utf8))
  }
  public static func embed(_ workflow: SidecarWorkflow, in xmp: String) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let json = String(decoding: try encoder.encode(workflow), as: UTF8.self)
    return try convert(json: json, xmp: xmp)
  }
  public static func validate(_ workflow: SidecarWorkflow) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let json = String(decoding: try encoder.encode(workflow), as: UTF8.self)
    _ = try convert(json: json, xmp: nil)
  }
  private static func convert(json: String?, xmp: String?) throws -> String {
    let jsonBytes = Array((json ?? "").utf8)
    let xmpBytes = Array((xmp ?? "").utf8)
    guard jsonBytes.count <= WorkflowContract.maxBytes, xmpBytes.count <= WorkflowContract.maxBytes
    else {
      throw WorkflowSidecarError(message: "Workflow input exceeds byte budget")
    }
    let jsonInput = jsonBytes.isEmpty ? [UInt8(0)] : jsonBytes
    let xmpInput = xmpBytes.isEmpty ? [UInt8(0)] : xmpBytes
    var output = [UInt8](repeating: 0, count: WorkflowContract.maxBytes)
    var length: UInt = 0
    let code = jsonInput.withUnsafeBufferPointer { jsonBuffer in
      xmpInput.withUnsafeBufferPointer { xmpBuffer in
        output.withUnsafeMutableBufferPointer { out in
          if json == nil {
            return maple_workflow_read_xmp(
              xmpBuffer.baseAddress, UInt(xmpBytes.count), out.baseAddress, UInt(out.count), &length
            )
          }
          if xmp == nil {
            return maple_workflow_validate_json(
              jsonBuffer.baseAddress, UInt(jsonBytes.count), out.baseAddress, UInt(out.count),
              &length)
          }
          return maple_workflow_embed_xmp(
            jsonBuffer.baseAddress, UInt(jsonBytes.count), xmpBuffer.baseAddress,
            UInt(xmpBytes.count), out.baseAddress, UInt(out.count), &length)
        }
      }
    }
    guard code == 0, length <= UInt(output.count) else {
      let message =
        maple_last_error().map { String(cString: $0) } ?? "Workflow conversion failed (\(code))"
      throw WorkflowSidecarError(message: message)
    }
    return String(decoding: output.prefix(Int(length)), as: UTF8.self)
  }
}
