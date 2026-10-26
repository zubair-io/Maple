import Foundation

extension ThumbnailSource {
  /// Whether the display tier is one fixed size whatever `maxDimension` a
  /// caller asks for (#5432). Only PhotoKit renders to the requested size;
  /// the local `.maple/previews` tier, `ImageSource.preview(for:)` and the
  /// server's `/api/preview` are all a single 1280 px artifact. Re-requesting
  /// a fixed tier for "more pixels" downloads the same bytes again.
  public var hasFixedPreviewTier: Bool {
    if case .photoKit = resolvedBackend() { return false }
    return true
  }

  /// The backend's name in `PreviewLoadLog` lines.
  public var previewLogKind: String {
    switch resolvedBackend() {
    case .thumbnailLoader(let ref, let box):
      if ref.primaryURL != nil { return "local" }
      if ref.displayPreviewProvider != nil || box?.source is CloudSource { return "cloud" }
      return box?.source == nil ? "sourceless" : "source"
    case .cloudThumb: return "cloud"
    case .photoKit: return "photokit"
    }
  }
}
