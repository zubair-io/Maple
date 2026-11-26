// ScrollRunFolder.swift — the throwaway folder the grid scroll measurement
// browses (#6048): `count` clones of the files in a seed folder, kept in the
// app's own temporary directory. The seed is only ever read, and the one
// directory this deletes is the one it created, so a run can never touch a
// photographer's library. Clones share storage with the seed on APFS, which
// is what lets a real iPad hold a 2,000-RAW folder from a few dozen files.

import Foundation

public enum ScrollRunFolder {
  public enum StagingError: Error, Equatable {
    case seedHasNoFiles
    case countOutOfRange
  }

  public struct Staged: Equatable, Sendable {
    public let url: URL
    public let reused: Bool
  }

  public static let countRange = 1...20_000

  public static func stage(
    seed: URL, count: Int, reuse: Bool,
    root: URL = FileManager.default.temporaryDirectory
  ) throws -> Staged {
    guard countRange.contains(count) else { throw StagingError.countOutOfRange }
    let fm = FileManager.default
    let folder = root.appendingPathComponent("maple-scroll-run-\(count)", isDirectory: true)
    if reuse, stagedFileCount(in: folder) == count {
      return Staged(url: folder, reused: true)
    }
    let sources = try fm.contentsOfDirectory(
      at: seed, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles]
    )
    .filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true }
    .sorted { $0.lastPathComponent < $1.lastPathComponent }
    guard !sources.isEmpty else { throw StagingError.seedHasNoFiles }
    if fm.fileExists(atPath: folder.path) { try fm.removeItem(at: folder) }
    try fm.createDirectory(at: folder, withIntermediateDirectories: true)
    for index in 0..<count {
      let source = sources[index % sources.count]
      let name = String(format: "IMG_%05d.%@", index, source.pathExtension)
      try fm.copyItem(at: source, to: folder.appendingPathComponent(name))
    }
    return Staged(url: folder, reused: false)
  }

  private static func stagedFileCount(in folder: URL) -> Int {
    let entries =
      (try? FileManager.default.contentsOfDirectory(
        at: folder, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])) ?? []
    return entries.filter { $0.lastPathComponent.hasPrefix("IMG_") }.count
  }
}
