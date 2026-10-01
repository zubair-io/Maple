// Kernel-released plan lease (#3944). Unlike process inspection, flock is
// the same coordination primitive already used by Maple XMP writes on Apple.
import Darwin
import Foundation

final class LocalRelocationLease: @unchecked Sendable, Equatable {
  let id = UUID().uuidString
  private let mutex = NSLock()
  private var descriptor: Int32

  init(target: URL) throws {
    let url = target.deletingLastPathComponent().appendingPathComponent(
      ".\(target.lastPathComponent).relocation.lock")
    let descriptor = Darwin.open(url.path, O_CREAT | O_RDWR, 0o600)
    guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
      close(descriptor)
      throw RemovalError.saveConflict
    }
    self.descriptor = descriptor
  }

  static func == (lhs: LocalRelocationLease, rhs: LocalRelocationLease) -> Bool { lhs === rhs }

  deinit { release() }

  func release() {
    mutex.lock()
    defer { mutex.unlock() }
    if descriptor >= 0 {
      flock(descriptor, LOCK_UN)
      close(descriptor)
      descriptor = -1
    }
    // Never unlink the persistent lease file: a different inode would allow
    // another writer to acquire what appears to be the same lock.
  }
}
