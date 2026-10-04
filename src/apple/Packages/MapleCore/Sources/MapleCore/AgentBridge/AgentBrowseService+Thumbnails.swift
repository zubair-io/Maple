import CoreGraphics
import CoreImage
import Foundation
import ImageIO

extension AgentBrowseService {
  static func loadThumbnailJPEG(
    for asset: AssetRef,
    delegate: any AgentBrowseDelegate,
    activeSession: EditSession?,
    maxEdge: Int
  ) async -> (Data, Int, Int)? {
    if let session = activeSession, session.asset.id == asset.id {
      let revision = AgentEditService.revision(of: session)
      if let surface = await session.agentCanvasSnapshot() {
        let pipeline = session.pipeline
        let inspection = await Task.detached(priority: .utility) {
          try? AgentInspector.inspect(
            surface, maxEdge: maxEdge, region: nil, context: pipeline.context)
        }.value
        guard AgentEditService.revision(of: session) == revision else { return nil }
        if let inspection { return (inspection.jpeg, inspection.width, inspection.height) }
      }
    }
    if let url = asset.primaryURL,
      let data = await ThumbnailLoader.shared.load(for: url, scopeParentURL: asset.scopeParentURL)
    {
      if let thumbnail = await Task.detached(
        priority: .utility,
        operation: {
          thumbnailJPEG(data: data, maxEdge: maxEdge)
        }
      ).value {
        return thumbnail
      }
    }
    if let provider = asset.displayPreviewProvider, let data = try? await provider() {
      if let thumbnail = await Task.detached(
        priority: .utility,
        operation: {
          thumbnailJPEG(data: data, maxEdge: maxEdge)
        }
      ).value {
        return thumbnail
      }
    }
    return await Task.detached(priority: .utility) {
      guard !Task.isCancelled, let url = asset.primaryURL else { return nil }
      let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
      let claimed = scope.startAccessingSecurityScopedResource()
      defer { if claimed { scope.stopAccessingSecurityScopedResource() } }
      guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateThumbnailAtIndex(
          source, 0, thumbnailOptions(maxEdge: maxEdge)),
        let jpeg = try? AgentInspector.jpeg(image)
      else { return nil }
      return (jpeg, image.width, image.height)
    }.value
  }

  nonisolated static func thumbnailJPEG(data: Data, maxEdge: Int) -> (Data, Int, Int)? {
    guard let image = decodeAndDownsample(data: data, maxEdge: maxEdge),
      let jpeg = try? AgentInspector.jpeg(image)
    else { return nil }
    return (jpeg, image.width, image.height)
  }

  nonisolated static func decodeAndDownsample(data: Data, maxEdge: Int) -> CGImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      CGImageSourceGetCount(source) > 0
    else { return nil }
    return CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions(maxEdge: maxEdge))
  }

  nonisolated private static func thumbnailOptions(maxEdge: Int) -> CFDictionary {
    [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceThumbnailMaxPixelSize: maxEdge,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
    ] as CFDictionary
  }
}
