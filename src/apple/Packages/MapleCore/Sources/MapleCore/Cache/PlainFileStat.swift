import Foundation

struct PlainFileStat {
  let fileNumber: UInt64
  let size: UInt64
  let modified: Date

  private static let referenceDateOffsetSeconds = 978_307_200.0

  /// A bare `lstat` that skips the extended attributes `FileManager.attributesOfItem` reads.
  static func read(atPath path: String) -> PlainFileStat? {
    var info = stat()
    var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
    // The `fileSystemRepresentation` property raises an exception on an empty path.
    guard
      (path as NSString).getFileSystemRepresentation(&buffer, maxLength: buffer.count),
      lstat(buffer, &info) == 0
    else { return nil }
    // Going through seconds since 1970 differs from Foundation's value in the last bit for
    // about half of files, and the bit pattern is persisted in source stamps.
    let seconds = Double(info.st_mtimespec.tv_sec) - referenceDateOffsetSeconds
    let referenceInterval = seconds + Double(info.st_mtimespec.tv_nsec) / 1e9
    return PlainFileStat(
      fileNumber: UInt64(info.st_ino),
      size: UInt64(clamping: info.st_size),
      modified: Date(timeIntervalSinceReferenceDate: referenceInterval))
  }

  static func modificationDate(atPath path: String) -> Date? {
    read(atPath: path)?.modified
  }
}
