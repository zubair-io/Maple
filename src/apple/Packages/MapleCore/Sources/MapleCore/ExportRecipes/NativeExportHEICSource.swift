import CoreGraphics
import Darwin
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Native HEIC decoding feeds the existing shared TIFF recipe chain, never a new color chain.
enum NativeExportHEICSource {
  static func withSource(_ original: URL, render: (URL) throws -> Void) throws {
    guard
      let source = CGImageSourceCreateWithURL(
        original as CFURL,
        [kCGImageSourceShouldCache: false] as CFDictionary),
      let type = CGImageSourceGetType(source) as String?,
      [UTType.heic.identifier, UTType.heif.identifier].contains(type)
    else {
      try render(original)
      return
    }
    let encoded = try tiff(source)
    var template = Array(
      FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-heic-recipe-XXXXXX").path.utf8CString)
    let path = template.withUnsafeMutableBufferPointer { buffer -> String? in
      guard let base = buffer.baseAddress, mkdtemp(base) != nil else { return nil }
      return String(cString: base)
    }
    guard let path else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    let workspace = URL(fileURLWithPath: path, isDirectory: true)
    var workspaceIdentity: String?
    var artifacts: NativeExportArtifacts?
    do {
      workspaceIdentity = try NativeExportStorage.identity(workspace)
      let capture = try NativeExportArtifacts(workspace: workspace, id: UUID())
      artifacts = capture
      let job = capture.snapshot()
      let sources = workspace.appendingPathComponent("Jobs", isDirectory: true)
        .appendingPathComponent(job.id.uuidString, isDirectory: true)
        .appendingPathComponent("Sources", isDirectory: true)
      try FileManager.default.createDirectory(at: sources, withIntermediateDirectories: false)
      let input = sources.appendingPathComponent("primary.tif")
      try capture.write(encoded, to: input)
      try render(input)
    } catch {
      let failure = error
      do {
        try cleanup(artifacts?.snapshot(), workspace: workspace, identity: workspaceIdentity)
      } catch {
        throw NativeExportError.message(
          "\(failure.localizedDescription) Private HEIC transport cleanup could not be verified; its files were preserved at \(workspace.path). \(error.localizedDescription)"
        )
      }
      throw failure
    }
    try cleanup(artifacts?.snapshot(), workspace: workspace, identity: workspaceIdentity)
  }

  private static func cleanup(_ job: NativeExportOwnedJob?, workspace: URL, identity: String?)
    throws
  {
    guard let identity, try NativeExportStorage.identity(workspace) == identity else {
      throw NativeExportError.message("Private HEIC transport changed; its files were preserved.")
    }
    if let job { try NativeExportArtifacts.remove(job, workspace: workspace) }
    // rmdir fails closed if any unknown entry arrived; it never recursively deletes one.
    let jobs = workspace.appendingPathComponent("Jobs")
    let removedJobs = Darwin.rmdir(jobs.path) == 0 || errno == ENOENT
    guard removedJobs, Darwin.rmdir(workspace.path) == 0 else {
      throw NativeExportError.message("Private HEIC transport changed; its files were preserved.")
    }
  }

  static func tiff(_ source: CGImageSource) throws -> Data {
    guard
      let image = CGImageSourceCreateImageAtIndex(
        source, 0,
        [kCGImageSourceShouldAllowFloat: true] as CFDictionary),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    else {
      throw NativeExportError.message(
        "This HEIC/HEIF original could not be decoded. The original was preserved.")
    }
    let encoded = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        encoded,
        UTType.tiff.identifier as CFString, 1, nil)
    else { throw NativeExportError.message("Native lossless HEIC transport is unavailable.") }
    let orientation = properties[kCGImagePropertyOrientation] as? NSNumber ?? 1
    CGImageDestinationAddImage(
      destination, image,
      [
        kCGImagePropertyOrientation: orientation,
        kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFCompression: 1],
      ] as CFDictionary)
    guard CGImageDestinationFinalize(destination),
      let transported = CGImageSourceCreateWithData(encoded, nil),
      let decoded = CGImageSourceCreateImageAtIndex(
        transported, 0,
        [kCGImageSourceShouldAllowFloat: true] as CFDictionary),
      decoded.width == image.width, decoded.height == image.height,
      decoded.bitsPerComponent >= image.bitsPerComponent,
      decoded.bitmapInfo.contains(.floatComponents) == image.bitmapInfo.contains(.floatComponents),
      decoded.colorSpace?.copyICCData() == image.colorSpace?.copyICCData()
    else {
      throw NativeExportError.message(
        "The HEIC/HEIF original's native color profile or bit depth could not be preserved. Choose another source; the original was left intact."
      )
    }
    return encoded as Data
  }
}
