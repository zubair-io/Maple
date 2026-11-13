import Foundation

/// What `BackupEngine` needs from PhotoKit. Real implementation in
/// `PhotoKitAssetReader` (Phase 3).
public protocol AssetReader: Actor {
  func read(phassetLocalId: String) async throws -> AssetReadResult
  func read(
    phassetLocalId: String,
    onStatus: @escaping @Sendable (String) async -> Void
  ) async throws -> AssetReadResult
  /// Reads one of an earlier `read`'s `deferredCompanions`. Returns nil
  /// when the asset or resource no longer exists; throws when it exists but
  /// could not be read, so the task retries.
  func readCompanion(_ kind: CompanionKind, phassetLocalId: String) async throws -> Data?
}

extension AssetReader {
  public func read(
    phassetLocalId: String,
    onStatus: @escaping @Sendable (String) async -> Void
  ) async throws -> AssetReadResult {
    try await read(phassetLocalId: phassetLocalId)
  }

  public func readCompanion(_ kind: CompanionKind, phassetLocalId: String) async throws -> Data? {
    nil
  }
}

/// A companion resource uploaded after the primary bytes land.
public enum CompanionKind: Sendable, Hashable {
  case rendered
  case liveVideo
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
  /// Companions that exist but were not read with the original; the engine
  /// reads each through `readCompanion` once the primary bytes land.
  public let deferredCompanions: Set<CompanionKind>

  /// Whether a Live Photo video or edited render must land with the original.
  var hasCompanions: Bool {
    !deferredCompanions.isEmpty || renderedBytes?.isEmpty == false
      || liveVideoBytes?.isEmpty == false
  }

  public init(
    originalBytes: Data, renderedBytes: Data?,
    renderedFilenameExtension: String? = nil,
    liveVideoBytes: Data? = nil, liveVideoFilename: String? = nil,
    sidecar: PayloadAssembler.SidecarInput, mapleId: String,
    deferredCompanions: Set<CompanionKind> = []
  ) {
    self.originalBytes = originalBytes
    self.renderedBytes = renderedBytes
    self.renderedFilenameExtension = renderedFilenameExtension
    self.liveVideoBytes = liveVideoBytes
    self.liveVideoFilename = liveVideoFilename
    self.sidecar = sidecar
    self.mapleId = mapleId
    self.deferredCompanions = deferredCompanions
  }
}
