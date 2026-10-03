// Compile with PanoProvisionManifest.swift: reuse the actual Mac install pins (#1472).
import Foundation

@main
struct MacRuntimeManifest {
  static func main() throws {
    guard let spec = PanoProvisionManifest.ortRuntime,
      case .ortTarball(let path, let digest) = spec.kind
    else { throw CocoaError(.featureUnsupported) }
    #if arch(arm64)
      let architecture = "arm64"
    #else
      let architecture = "x86_64"
    #endif
    let record: [String: Any] = [
      "architecture": architecture, "url": spec.url.absoluteString,
      "archive_sha256": spec.sha256, "archive_size": spec.size,
      "internal_path": path, "installed_sha256": digest,
    ]
    let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
  }
}
