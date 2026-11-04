import Foundation

/// Decides whether the backup engine may run. It stays down while the app is
/// leaving the foreground (suspension) and while any panorama stitch holds a
/// pause; the two compose, so releasing the last pause in the background never
/// restarts the engine.
public struct BackupRunGate: Sendable {
  private var pauses: Set<UUID> = []
  public private(set) var isSuspended = false

  public init() {}

  public var isPaused: Bool { !pauses.isEmpty }
  public var mayRun: Bool { !isSuspended && pauses.isEmpty }

  public mutating func pause() -> UUID {
    let id = UUID()
    pauses.insert(id)
    return id
  }

  /// True when this call dropped the last pause. An unknown or already released
  /// id changes nothing, so a double release cannot undo another holder's pause.
  public mutating func release(_ id: UUID) -> Bool {
    pauses.remove(id) != nil && pauses.isEmpty
  }

  public mutating func suspend() { isSuspended = true }
  public mutating func resume() { isSuspended = false }
}
