// SidecarOwnership.swift — the shared-sidecar ownership rule (#4707, API
// twin #4692 `src/api/src/fs/sidecar-ownership.ts`). See
// docs/xmp-canonical-format.md § "Moving, renaming and trashing a photo":
// images swap the extension, so `IMG_1.CR3` and `IMG_1.JPG` both read
// `IMG_1.xmp`, and a file operation must never treat that sidecar as
// exclusively the moving photo's. The stem rule is pure name logic; the
// local and SMB wrappers supply each engine's listing and file identity.

import Foundation

enum SidecarOwnership {

  /// NFC-normalised sidecar stem: the full name for a video (full-name
  /// sidecars, `clip.mov.xmp`), the name minus its extension for everything
  /// else. Lowercased only where the volume folds case: on a case-sensitive
  /// one `IMG.CR3` and `img.JPG` read different sidecars.
  static func stem(of filename: String, foldsCase: Bool = true) -> String {
    let url = URL(fileURLWithPath: filename)
    let base = SidecarPath.isVideo(url) ? filename : url.deletingPathExtension().lastPathComponent
    let normalized = base.precomposedStringWithCanonicalMapping
    return foldsCase ? normalized.lowercased() : normalized
  }

  /// An in-flight staging copy (`<name>.tmp.<pid>-<hex>` from the Apple
  /// engines, `.tmp.<pid>-<hex>` / `.tmp.<pid>.<hex>` from the API) is not a
  /// sibling photo. A real name such as `IMG.tmp.JPG` is.
  static func isStagingName(_ name: String) -> Bool {
    name.range(of: #"\.tmp\.[0-9]+[-.][0-9A-Fa-f]+$"#, options: .regularExpression) != nil
  }

  /// Whether names on `directory`'s volume compare case-insensitively. An
  /// unknown answer counts as folding: the over-inclusive side of the rule.
  static func localVolumeFoldsCase(_ directory: URL) -> Bool {
    let values = try? directory.resourceValues(forKeys: [.volumeSupportsCaseSensitiveNamesKey])
    return values?.volumeSupportsCaseSensitiveNames.map { !$0 } ?? true
  }

  /// True when a file named in `siblingNames` (the non-directory entries of
  /// `primaryPath`'s folder), other than the primary and `excluding`, shares
  /// its sidecar stem. Over-inclusive on purpose: a false positive leaves a
  /// harmless duplicate sidecar behind, a false negative carries away another
  /// photo's edits.
  static func stemClaimedBySibling(
    primaryPath: String, siblingNames: [String], excluding: [String] = [], foldsCase: Bool = true
  ) -> Bool {
    let dir = (primaryPath as NSString).deletingLastPathComponent
    let key: (String) -> String = foldsCase ? folded : exact
    let skipped = Set(([primaryPath] + excluding).map(key))
    let primaryStem = stem(of: (primaryPath as NSString).lastPathComponent, foldsCase: foldsCase)
    return siblingNames.contains { name in
      !name.hasPrefix(".") && !isStagingName(name)
        && (name as NSString).pathExtension.lowercased() != "xmp"
        && !skipped.contains(key((dir as NSString).appendingPathComponent(name)))
        && stem(of: name, foldsCase: foldsCase) == primaryStem
    }
  }

  /// An unlistable folder counts as claimed: copying is always safe, taking is not.
  static func localStemClaimedBySibling(_ primaryURL: URL, excluding: [URL] = []) -> Bool {
    let directory = primaryURL.deletingLastPathComponent()
    guard
      let entries = try? FileManager.default.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: [.isDirectoryKey])
    else { return true }
    let names = entries.filter {
      (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) != true
    }.map(\.lastPathComponent)
    return stemClaimedBySibling(
      primaryPath: primaryURL.path, siblingNames: names, excluding: excluding.map(\.path),
      foldsCase: localVolumeFoldsCase(directory))
  }

  /// The SMB transport reports no per-share case sensitivity, so stems fold
  /// case here — the over-inclusive side, matching SMB's usual semantics.
  static func smbStemClaimedBySibling(
    _ primaryPath: String, excluding: [String] = [], transport: SMBFileTransport
  ) async -> Bool {
    let dir = (primaryPath as NSString).deletingLastPathComponent
    let prefix = dir.hasSuffix("/") ? dir : dir + "/"
    guard let entries = try? await transport.contentsOfDirectory(atPath: dir, recursive: false)
    else { return true }
    let names = entries.compactMap { attrs -> String? in
      guard (attrs[.isDirectoryKey] as? Bool) != true, let name = attrs[.nameKey] as? String
      else { return nil }
      let path = (attrs[.pathKey] as? String) ?? prefix + name
      let relative = path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : name
      return relative.contains("/") ? nil : name
    }
    return stemClaimedBySibling(primaryPath: primaryPath, siblingNames: names, excluding: excluding)
  }

  /// Rule 3's "maps onto itself" asks whether two names are one FILE — the
  /// identical path, a case-only difference where the volume folds case, or
  /// a name reached through a symlinked folder — so the answer comes from
  /// file identity (device + inode), never a string compare.
  static func sameLocalFile(_ a: String, _ b: String) -> Bool {
    guard exact(a) != exact(b) else { return true }
    let fm = FileManager.default
    guard let ia = try? fm.attributesOfItem(atPath: a), let ib = try? fm.attributesOfItem(atPath: b)
    else { return false }
    return (ia[.systemNumber] as? NSNumber) == (ib[.systemNumber] as? NSNumber)
      && (ia[.systemFileNumber] as? NSNumber) == (ib[.systemFileNumber] as? NSNumber)
      && ia[.systemFileNumber] != nil
  }

  /// Only a matching, nonzero server file id proves that two spellings name
  /// one file. Unknown identity must retain normal collision handling, since
  /// a case-sensitive share can hold unrelated edits at both spellings.
  static func sameSMBFile(_ a: String, _ b: String, transport: SMBFileTransport) async -> Bool {
    guard exact(a) != exact(b) else { return true }
    guard folded(a) == folded(b),
      let ia = try? await transport.attributesOfItem(atPath: a),
      let ib = try? await transport.attributesOfItem(atPath: b)
    else { return false }
    let idA = (ia[.documentIdentifierKey] as? NSNumber)?.uint64Value ?? 0
    let idB = (ib[.documentIdentifierKey] as? NSNumber)?.uint64Value ?? 0
    return idA != 0 && idB != 0 && idA == idB
  }

  /// The destination already holds exactly the incoming sidecar's bytes — the
  /// one an earlier same-stem photo of the pair carried there. Joining it
  /// neither overwrites nor adopts different edits, so it is not a collision.
  static func localSidecarAlreadyCarried(_ source: String, at destination: String) -> Bool {
    FileManager.default.contentsEqual(atPath: source, andPath: destination)
  }

  static func smbSidecarAlreadyCarried(
    _ source: String, at destination: String, transport: SMBFileTransport
  ) async -> Bool {
    guard let a = try? await transport.readFile(atPath: source),
      let b = try? await transport.readFile(atPath: destination)
    else { return false }
    return a == b
  }

  private static func exact(_ path: String) -> String {
    URL(fileURLWithPath: path).standardizedFileURL.path.precomposedStringWithCanonicalMapping
  }

  private static func folded(_ path: String) -> String { exact(path).lowercased() }
}
