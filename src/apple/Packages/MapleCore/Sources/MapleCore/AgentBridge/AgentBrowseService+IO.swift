import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import MapleAgentWire

extension AgentBrowseService {
  nonisolated(unsafe) private static let iso8601Formatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
  }()

  /// Read the asset's capture timestamp formatted as ISO 8601 UTC.
  /// Prioritizes EXIF `DateTimeOriginal` / `CreateDate` via `ImageMetadataReader`
  /// and `ExifCaptureDate`, falling back to filesystem creation date if EXIF
  /// is missing or unparseable.
  nonisolated static func captureTimestamp(for asset: AssetRef) -> String? {
    if let url = asset.primaryURL {
      let rawDates = ImageMetadataReader.readRawCaptureDateStrings(from: url)
      if let iso = rawDates.dateTimeOriginal.flatMap(ExifCaptureDate.iso8601UTC(fromExifString:))
        ?? rawDates.createDate.flatMap(ExifCaptureDate.iso8601UTC(fromExifString:))
      {
        return iso
      }
      if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
        let date = attrs[.creationDate] as? Date
      {
        return iso8601Formatter.string(from: date)
      }
    }
    return nil
  }

  /// Resolve culling state for an asset, preferring pre-cached in-memory
  /// session state and falling back to reading the on-disk XMP sidecar.
  nonisolated static func cullingState(for asset: AssetRef, cached: CullingState?) -> CullingState {
    if let cached {
      return cached
    }
    if let url = asset.primaryURL {
      let sidecarURL = SidecarPath.sidecarURL(for: url)
      if FileManager.default.fileExists(atPath: sidecarURL.path),
        let xml = try? String(contentsOf: sidecarURL, encoding: .utf8),
        let (_, culling) = try? XMPParser.parse(xml)
      {
        return culling
      }
    }
    return CullingState()
  }

  /// Load a compressed JPEG thumbnail for the given asset.
  ///
  /// Priority:
  /// 1. Active edit session canvas snapshot: When a photo is currently open in
  ///    the editor, this prioritizes the live adjusted surface over on-disk
  ///    thumbnails so grid culling reflects in-progress edits and crops.
  /// 2. `ThumbnailLoader.shared`: Fast retrieval from Maple's disk thumbnail cache.
  /// 3. `asset.displayPreviewProvider`: Decoded preview for remote / PhotoKit assets.
  /// 4. Direct CGImageSource downsampled thumbnail from the primary file URL.
  static func loadThumbnailJPEG(
    for asset: AssetRef,
    delegate: any AgentBrowseDelegate,
    activeSession: EditSession?,
    maxEdge: Int
  ) async -> (Data, Int, Int)? {
    if activeSession?.asset.id == asset.id, let surface = await activeSession?.agentCanvasSnapshot()
    {
      let context = activeSession?.pipeline.context ?? CIContext()
      if let inspection = try? AgentInspector.inspect(
        surface, maxEdge: maxEdge, region: nil, context: context)
      {
        return (inspection.jpeg, inspection.width, inspection.height)
      }
    }

    if let url = asset.primaryURL {
      if let data = await ThumbnailLoader.shared.load(
        for: url, scopeParentURL: asset.scopeParentURL),
        let cgImage = decodeAndDownsample(data: data, maxEdge: maxEdge),
        let jpeg = try? AgentInspector.jpeg(cgImage)
      {
        return (jpeg, cgImage.width, cgImage.height)
      }
    }

    if let previewProvider = asset.displayPreviewProvider,
      let data = try? await previewProvider(),
      let cgImage = decodeAndDownsample(data: data, maxEdge: maxEdge),
      let jpeg = try? AgentInspector.jpeg(cgImage)
    {
      return (jpeg, cgImage.width, cgImage.height)
    }

    if let bytesProvider = asset.bytesProvider,
      let data = try? await bytesProvider(),
      let cgImage = decodeAndDownsample(data: data, maxEdge: maxEdge),
      let jpeg = try? AgentInspector.jpeg(cgImage)
    {
      return (jpeg, cgImage.width, cgImage.height)
    }

    if let url = asset.primaryURL,
      let source = CGImageSourceCreateWithURL(url as CFURL, nil)
    {
      let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceThumbnailMaxPixelSize: maxEdge,
        kCGImageSourceCreateThumbnailWithTransform: true,
      ]
      if let cgThumb = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
        let jpeg = try? AgentInspector.jpeg(cgThumb)
      {
        return (jpeg, cgThumb.width, cgThumb.height)
      }
    }

    return nil
  }

  static func decodeAndDownsample(data: Data, maxEdge: Int) -> CGImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      CGImageSourceGetCount(source) > 0
    else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceThumbnailMaxPixelSize: maxEdge,
      kCGImageSourceCreateThumbnailWithTransform: true,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
  }
}
