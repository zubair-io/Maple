import Foundation

/// RAW+JPEG stack pairing for sources that list plain files: local folders and SMB shares. The
/// same name-based rule the Self Hosted listing applies (`library/raw-jpeg-stack.ts`, #5050): a
/// RAW and a JPEG that share a folder and a stem (NFC-normalised, case-folded) form one stack
/// only when that stem holds exactly one RAW and exactly one `.jpg`/`.jpeg`. Two JPEGs, two RAWs
/// or a RAW beside a HEIC stay independent. The pair shares one XMP sidecar, so two tiles would
/// edit the same file.
public enum RawJpegPairing {
  static let jpegExtensions: Set<String> = ["jpg", "jpeg"]

  public static func isJpeg(_ path: String) -> Bool {
    jpegExtensions.contains(pathExtension(path))
  }

  public static func isRaw(_ path: String) -> Bool {
    RAWExtensions.all.contains(pathExtension(path))
  }

  /// The stem two stacked files share: the filename minus its extension, NFC-normalised and
  /// case-folded.
  public static func stem(of path: String) -> String {
    ((path as NSString).lastPathComponent as NSString).deletingPathExtension
      .precomposedStringWithCanonicalMapping.lowercased()
  }

  /// The pairs among `paths`, keyed by the RAW's path with the JPEG's path as the value.
  public static func pairs(in paths: [String]) -> [String: String] {
    let groups = Dictionary(grouping: paths) { path in
      "\((path as NSString).deletingLastPathComponent)\0\(stem(of: path))"
    }
    return Dictionary(
      uniqueKeysWithValues: groups.values.compactMap { members -> (String, String)? in
        let raws = members.filter(isRaw)
        let jpegs = members.filter(isJpeg)
        guard raws.count == 1, jpegs.count == 1, let raw = raws.first, let jpeg = jpegs.first
        else { return nil }
        return (raw, jpeg)
      })
  }

  private static func pathExtension(_ path: String) -> String {
    (path as NSString).pathExtension.lowercased()
  }
}
