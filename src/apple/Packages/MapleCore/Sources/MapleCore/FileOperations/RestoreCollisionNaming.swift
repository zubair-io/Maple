import Foundation

/// Restore has a distinct collision namespace; ordinary relocate retains `.N` (#4139).
enum RestoreCollisionNaming {
  static func candidate(_ path: String, attempt: Int) -> String {
    guard attempt >= 0 else { return path }
    let ext = (path as NSString).pathExtension
    let stem = ext.isEmpty ? path : String(path.dropLast(ext.count + 1))
    let suffix = FilenameVocabulary.restoreCollisionSuffix + (attempt == 0 ? "" : ".\(attempt)")
    return stem + suffix + (ext.isEmpty ? "" : "." + ext)
  }
}
