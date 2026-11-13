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
  ///
  /// A lease known before coordination (a removal write, an existing lock
  /// inode) is taken first. Otherwise the decision reads the same coordinated
  /// sidecar text the write already holds, so an ordinary save reads it once.
  func withRemovalLease<T>(
    removalChange: Bool, _ coordinate: ((String?) throws -> Bool) throws -> T
  ) throws -> T {
    let leasedFirst =
      removalChange || FileManager.default.fileExists(atPath: removalLeaseURL.path)
    guard leasedFirst else {
      return try coordinate { existing in
        existing.map(RemovalXMPRecords.mayCarryRecords) == true
      }
    }
    return try holdingRemovalLease { try coordinate { _ in false } }
  }

  /// Non-blocking, so a coordinated writer that finds removals only after it
  /// read the file cannot deadlock against a leased writer awaiting coordination.
  func holdingRemovalLease<T>(_ body: () throws -> T) throws -> T {
    let descriptor = open(removalLeaseURL.path, O_CREAT | O_RDWR, 0o600)
    guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    defer { close(descriptor) }
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
      throw RemovalError.saveConflict
    }
    defer { flock(descriptor, LOCK_UN) }
    return try body()
  }

  private var removalLeaseURL: URL {
    sidecarURL.deletingLastPathComponent().appendingPathComponent(
      ".\(sidecarURL.lastPathComponent).lock")
  }
}
