// ScrollRunFolder.swift — the throwaway folder the grid scroll measurement
// browses (#6048): `count` clones of the photos in a seed folder, kept in the
// app's own temporary directory. The seed is only ever read, and the one
// directory this deletes is one that carries its own marker file, so a run
// can never touch a photographer's library. Files are cloned, never copied:
// clones share storage with the seed, which is what lets a real iPad hold a
// 2,000-RAW folder from a dozen files, and a seed that cannot be cloned
// (another volume) fails instead of filling the disk.

import Foundation

public enum ScrollRunFolder {
  public enum StagingError: Error, Equatable {
    case seedHasNoPhotos
    case countOutOfRange
    case seedInsideStagedFolder
    case folderNotStagedByScrollRun
    case cloneFailed(errno: Int32)
  }

  public struct Staged: Equatable, Sendable {
    public let url: URL
    public let reused: Bool
  }

  public static let countRange = 1...20_000
  static let markerName = ".maple-scroll-run"

  public static func stage(
    seed: URL, count: Int, reuse: Bool,
    root: URL = FileManager.default.temporaryDirectory
  ) throws -> Staged {
    guard countRange.contains(count) else { throw StagingError.countOutOfRange }
    let fm = FileManager.default
    let folder = root.appendingPathComponent("maple-scroll-run-\(count)", isDirectory: true)
    let folderPath = folder.resolvingSymlinksInPath().path
    let seedPath = seed.resolvingSymlinksInPath().path
    guard seedPath != folderPath, !seedPath.hasPrefix(folderPath + "/") else {
      throw StagingError.seedInsideStagedFolder
    }
    if reuse, stagedFileCount(in: folder) == count {
      return Staged(url: folder, reused: true)
    }
    let sources = try fm.contentsOfDirectory(
      at: seed, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles]
    )
    .filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true }
    .filter { SupportedImageExtensions.all.contains($0.pathExtension.lowercased()) }
    .sorted { $0.lastPathComponent < $1.lastPathComponent }
    guard !sources.isEmpty else { throw StagingError.seedHasNoPhotos }
    if fm.fileExists(atPath: folder.path) {
      guard fm.fileExists(atPath: folder.appendingPathComponent(markerName).path) else {
        throw StagingError.folderNotStagedByScrollRun
      }
      try fm.removeItem(at: folder)
    }
    try fm.createDirectory(at: folder, withIntermediateDirectories: true)
    try Data().write(to: folder.appendingPathComponent(markerName))
    for index in 0..<count {
      let source = sources[index % sources.count]
      let name = String(format: "IMG_%05d.%@", index, source.pathExtension)
      guard clonefile(source.path, folder.appendingPathComponent(name).path, 0) == 0 else {
        throw StagingError.cloneFailed(errno: errno)
      }
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
