import Foundation

/// What `BackupEngine` needs from PhotoKit. Real implementation in
/// `PhotoKitAssetReader` (Phase 3).
public protocol AssetReader: Actor {
  func read(phassetLocalId: String) async throws -> AssetReadResult
  func read(
    phassetLocalId: String,
    onStatus: @escaping @Sendable (String) async -> Void
  ) async throws -> AssetReadResult
}

extension AssetReader {
  public func read(
    phassetLocalId: String,
    onStatus: @escaping @Sendable (String) async -> Void
  ) async throws -> AssetReadResult {
    try await read(phassetLocalId: phassetLocalId)
  }
}

public struct AssetReadResult: Sendable {
  public let originalBytes: Data
  public let renderedBytes: Data?
  /// Bytes of the Live Photo .mov twin, if the asset is a Live Photo.
  /// Uploaded separately via the rendered endpoint with ext "mov".
  /// Lands as `<base>.mov` via suffix-override.
  public let liveVideoBytes: Data?
  /// Filename for the Live Photo .mov twin (e.g. "IMG_1234.mov").
  public let liveVideoFilename: String?
  public let sidecar: PayloadAssembler.SidecarInput
  public let mapleId: String

  public init(
    originalBytes: Data, renderedBytes: Data?,
    liveVideoBytes: Data? = nil, liveVideoFilename: String? = nil,
    sidecar: PayloadAssembler.SidecarInput, mapleId: String
  ) {
    self.originalBytes = originalBytes
    self.renderedBytes = renderedBytes
    self.liveVideoBytes = liveVideoBytes
    self.liveVideoFilename = liveVideoFilename
    self.sidecar = sidecar
    self.mapleId = mapleId
  }
}
