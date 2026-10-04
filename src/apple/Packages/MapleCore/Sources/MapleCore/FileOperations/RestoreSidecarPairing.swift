import Foundation

/// Existing Web pairing contract, including conflict copies and UUID workflow
/// branches. Foreign `.v2` and bare numbered siblings belong to other assets.
enum RestoreSidecarPairing {
  static func base(_ primary: String) -> String {
    SidecarPath.sidecarURL(for: URL(fileURLWithPath: primary)).deletingPathExtension()
      .lastPathComponent
  }

  static func matchedNames(_ names: [String], primary: String) throws -> [String] {
    let stem = NSRegularExpression.escapedPattern(for: base(primary))
    let canonical = try NSRegularExpression(
      pattern: "^" + stem + FilenameVocabulary.pairedSidecarSuffixPattern + "$",
      options: .caseInsensitive)
    let workflow = try NSRegularExpression(
      pattern: "^(?i:" + stem + ")\\.v(?:" + WorkflowContract.uuidPattern + ")\\.xmp$")
    return names.filter { name in
      let range = NSRange(name.startIndex..<name.endIndex, in: name)
      return canonical.firstMatch(in: name, range: range) != nil
        || workflow.firstMatch(in: name, range: range) != nil
    }.sorted()
  }

  static func target(_ sidecar: String, from source: String, to destination: String) throws
    -> String
  {
    let name = (sidecar as NSString).lastPathComponent
    let oldBase = base(source)
    guard String(name.prefix(oldBase.count)).lowercased() == oldBase.lowercased() else {
      throw FileOperationError.invalidName(name)
    }
    return ((destination as NSString).deletingLastPathComponent as NSString)
      .appendingPathComponent(base(destination) + String(name.dropFirst(oldBase.count)))
  }
}
