import Foundation

/// What `BackupEngine` needs from PhotoKit. Real implementation in
/// `PhotoKitAssetReader` (Phase 3).
public protocol AssetReader: Actor {
  func read(phassetLocalId: String) async throws -> AssetReadResult
  func read(
    phassetLocalId: String,
    onStatus: @escaping @Sendable (String) async -> Void
  ) async throws -> AssetReadResult
  func readCompanions(
    phassetLocalId: String,
    onStatus: @escaping @Sendable (String) async -> Void
  ) async throws -> CompanionReadResult
}

extension AssetReader {
  public func read(
    phassetLocalId: String,
    onStatus: @escaping @Sendable (String) async -> Void
  ) async throws -> AssetReadResult {
    try await read(phassetLocalId: phassetLocalId)
  }

  public func readCompanions(
    phassetLocalId: String,
    onStatus: @escaping @Sendable (String) async -> Void
  ) async throws -> CompanionReadResult {
    CompanionReadResult()
  }
}

public struct CompanionReadResult: Sendable {
  public let renderedBytes: Data?
  public let renderedFilenameExtension: String?
  public let liveVideoBytes: Data?

  public init(
    renderedBytes: Data? = nil,
    renderedFilenameExtension: String? = nil,
    liveVideoBytes: Data? = nil
  ) {
    self.renderedBytes = renderedBytes
    self.renderedFilenameExtension = renderedFilenameExtension
    self.liveVideoBytes = liveVideoBytes
  }
}

public struct AssetReadResult: Sendable {
  public let originalBytes: Data
  public let renderedBytes: Data?
  /// Filename extension of the rendered bytes' own format (e.g. "jpeg" for
  /// an edited RAW), which can differ from the original's.
  public let renderedFilenameExtension: String?
  /// Bytes of the Live Photo .mov twin, if the asset is a Live Photo.
  /// Uploaded separately via the rendered endpoint with ext "mov".
  /// Lands as `<base>.mov` via suffix-override.
  public let liveVideoBytes: Data?
  /// Filename for the Live Photo .mov twin (e.g. "IMG_1234.mov").
  public let liveVideoFilename: String?
  public let sidecar: PayloadAssembler.SidecarInput
  public let mapleId: String
  /// True when rendered or Live Photo companion bytes exist in PhotoKit and
  /// should be fetched lazily via `readCompanions` after the primary upload lands.
  public let hasDeferredCompanions: Bool

  public init(
    originalBytes: Data, renderedBytes: Data?,
    renderedFilenameExtension: String? = nil,
    liveVideoBytes: Data? = nil, liveVideoFilename: String? = nil,
    sidecar: PayloadAssembler.SidecarInput, mapleId: String,
    hasDeferredCompanions: Bool = false
  ) {
    self.originalBytes = originalBytes
    self.renderedBytes = renderedBytes
    self.renderedFilenameExtension = renderedFilenameExtension
    self.liveVideoBytes = liveVideoBytes
    self.liveVideoFilename = liveVideoFilename
    self.sidecar = sidecar
    self.mapleId = mapleId
    self.hasDeferredCompanions = hasDeferredCompanions
  }
}
