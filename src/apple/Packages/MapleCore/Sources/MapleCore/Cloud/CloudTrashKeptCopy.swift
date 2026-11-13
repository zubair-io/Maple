// CloudTrashKeptCopy.swift — a Cloud permanent delete that kept the photo
// (#5403/#5419): another copy of it exists outside Trash, so the server
// removed only the trashed copy and the photo stays in the library at that
// other copy (`DeleteAssetResult.keptSurvivingCopy`). The Trash browser's
// notice and the grid's "is the kept photo in the folder on screen" check,
// worded the same way as the web Trash panel.

import Foundation

public enum CloudTrashKeptCopy {
  public static func notice(filename: String, cleanupPending: Bool) -> String {
    let kept =
      "Removed the copy of \"\(filename)\" in Trash. The photo was kept because another copy exists."
    return cleanupPending ? kept + " Its file cleanup will finish shortly." : kept
  }

  /// Whether a Cloud grid listing `folderPath` (a server absolute path) is
  /// the folder the kept photo at `keptAbsPath` now shows in.
  public static func folderShowsKeptCopy(folderPath: String, keptAbsPath: String?) -> Bool {
    guard let keptAbsPath else { return false }
    let keptFolder = (keptAbsPath as NSString).deletingLastPathComponent
    return normalized(keptFolder) == normalized(folderPath)
  }

  private static func normalized(_ path: String) -> String {
    path.count > 1 && path.hasSuffix("/") ? String(path.dropLast()) : path
  }
}
