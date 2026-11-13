// Persistent sidecar lease for removal-owned photos (#3940).
import Darwin
import Foundation

extension XMPSidecarStore {
  /// Only a sidecar that carries accepted removal records, a write that
  /// changes them, or a photo another owner has leased before (its lock inode
  /// exists) takes the persistent kernel lease: it is what stops an older
  /// Maple writer from replacing a newer removal (#3940). An ordinary save on
  /// any other photo keeps NSFileCoordinator alone, so no lock inode is left
  /// beside every edited photo and a coordinator-serialized peer (FileProvider,
  /// a variant store) is never refused with `saveConflict`.
  func withRemovalLease<T>(removalChange: Bool, _ body: () throws -> T) throws -> T {
    let lockURL = sidecarURL.deletingLastPathComponent().appendingPathComponent(
      ".\(sidecarURL.lastPathComponent).lock")
    let requiresLease =
      removalChange
      || FileManager.default.fileExists(atPath: lockURL.path)
      || ((try? existingSidecarXML(at: sidecarURL))?.contains("InpaintRemovals") ?? false)
    guard requiresLease else { return try body() }
    let descriptor = open(lockURL.path, O_CREAT | O_RDWR, 0o600)
    guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    defer { close(descriptor) }
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
      throw RemovalError.saveConflict
    }
    defer { flock(descriptor, LOCK_UN) }
    return try body()
  }
}
