// The sidecar name the server reads for a backed-up file (#5021). Mirrors MapleCore's
// `SidecarPath`, which MapleBackup cannot import; `SidecarPathTests` keeps them identical.

import Foundation

public enum BackupSidecarName {
  public static let videoExtensions: Set<String> = [
    "mov", "mp4", "m4v", "avi", "mkv", "webm", "mts", "m2ts", "3gp",
    "mxf", "3g2", "flv", "vob", "mpg", "wmv", "f4v",
  ]

  public static func isVideo(_ relPath: String) -> Bool {
    videoExtensions.contains((relPath as NSString).pathExtension.lowercased())
  }

  public static func canonical(for targetRelPath: String) -> String {
    isVideo(targetRelPath)
      ? targetRelPath + ".xmp"
      : (targetRelPath as NSString).deletingPathExtension + ".xmp"
  }
}
