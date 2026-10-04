import Darwin
import Foundation

struct NativeExportOwnedJob: Codable, Equatable, Sendable {
  struct File: Codable, Equatable, Sendable {
    let path: String
    let identity: String
    let hash: String
  }
  let id: UUID
  let identity: String
  let files: [File]
}

/// Only exclusively created, byte-proven private capture artifacts can be retired.
final class NativeExportArtifacts: @unchecked Sendable {
  private let root: URL
  private let id: UUID
  private let identity: String
  private let lock = NSLock()
  private var files: [NativeExportOwnedJob.File] = []

  init(workspace: URL, id: UUID) throws {
    let jobs = workspace.appendingPathComponent("Jobs", isDirectory: true)
    try FileManager.default.createDirectory(at: jobs, withIntermediateDirectories: true)
    let values = try jobs.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    guard values.isDirectory == true, values.isSymbolicLink != true else {
      throw NativeExportError.message("Private export storage is unavailable.")
    }
    self.root = jobs.appendingPathComponent(id.uuidString, isDirectory: true)
      .resolvingSymlinksInPath()
    self.id = id
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700])
    self.identity = try NativeExportStorage.identity(root)
  }

  func write(_ bytes: Data, to url: URL) throws {
    lock.lock()
    defer { lock.unlock() }
    let descriptor = Darwin.open(url.path, O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    defer { Darwin.close(descriptor) }
    var stat = Darwin.stat()
    guard Darwin.fstat(descriptor, &stat) == 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    let identity = "\(stat.st_dev):\(stat.st_ino)"
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
    do {
      try handle.write(contentsOf: bytes)
      try register(url, identity: identity)
      try handle.synchronize()
      try NativeExportStorage.syncDirectory(url.deletingLastPathComponent())
      try NativeExportStorage.syncDirectory(root)
      try NativeExportStorage.syncDirectory(root.deletingLastPathComponent())
    } catch {
      if !files.contains(where: { $0.identity == identity }) {
        try? register(url, identity: identity)
      }
      throw error
    }
  }

  private func register(_ url: URL, identity: String) throws {
    guard try NativeExportStorage.identity(url) == identity,
      let hash = try NativeExportStorage.hash(url)
    else {
      throw NativeExportError.message("Could not verify the private export capture.")
    }
    let path = url.resolvingSymlinksInPath().path
    files.append(
      .init(
        path: String(path.dropFirst(root.path.count + 1)),
        identity: identity, hash: hash))
  }

  func snapshot() -> NativeExportOwnedJob {
    lock.lock()
    defer { lock.unlock() }
    return .init(id: id, identity: identity, files: files)
  }

  static func referenced(
    _ job: NativeExportOwnedJob, by record: NativeExportRecord,
    workspace: URL
  ) -> Bool {
    let root = workspace.appendingPathComponent("Jobs/\(job.id.uuidString)").standardizedFileURL
      .path
    let urls = record.originals.map(\.url) + [record.filmDirectory].compactMap { $0 }
    return record.ownedJob?.id == job.id
      || urls.contains {
        let path = $0.resolvingSymlinksInPath().standardizedFileURL.path
        return path == root || path.hasPrefix(root + "/")
      }
  }

  static func claim(_ job: NativeExportOwnedJob, workspace: URL) throws -> URL? {
    let jobs = workspace.appendingPathComponent("Jobs", isDirectory: true).resolvingSymlinksInPath()
    let publicRoot = jobs.appendingPathComponent(job.id.uuidString, isDirectory: true)
    let claimed = jobs.appendingPathComponent("Retired-" + job.id.uuidString, isDirectory: true)
    if FileManager.default.fileExists(atPath: claimed.path) {
      try verifyDirectory(claimed, identity: job.identity)
      return claimed
    }
    guard FileManager.default.fileExists(atPath: publicRoot.path) else { return nil }
    try verifyDirectory(publicRoot, identity: job.identity)
    guard Darwin.renamex_np(publicRoot.path, claimed.path, UInt32(RENAME_EXCL)) == 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    // Verify AFTER claiming, so a replaced public directory is never accepted as our capture.
    try verifyDirectory(claimed, identity: job.identity)
    try NativeExportStorage.syncDirectory(jobs)
    return claimed
  }

  private static func verifyDirectory(_ root: URL, identity: String) throws {
    let values = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    guard values.isDirectory == true, values.isSymbolicLink != true,
      try NativeExportStorage.identity(root) == identity
    else {
      throw NativeExportError.message("A private capture changed; its files were preserved.")
    }
  }

  static func remove(_ job: NativeExportOwnedJob, workspace: URL) throws {
    guard let root = try claim(job, workspace: workspace) else { return }
    try removeClaimed(job, root: root)
  }

  static func removeClaimed(_ job: NativeExportOwnedJob, root: URL) throws {
    try verifyDirectory(root, identity: job.identity)
    let expected = Dictionary(uniqueKeysWithValues: job.files.map { ($0.path, $0) })
    guard
      let entries = FileManager.default.enumerator(
        at: root,
        includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey])
    else {
      throw NativeExportError.message("Could not inspect private capture artifacts.")
    }
    // Old public job paths are no longer our cleanup namespace. Unknown entrants are preserved.
    for case let url as URL in entries {
      let path = String(url.resolvingSymlinksInPath().path.dropFirst(root.path.count + 1))
      let type = try url.resourceValues(forKeys: [
        .isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey,
      ])
      guard type.isSymbolicLink != true else {
        throw NativeExportError.message("A private capture changed; its files were preserved.")
      }
      if type.isDirectory == true, ["Sources", "Film"].contains(path) { continue }
      guard type.isRegularFile == true, let file = expected[path],
        try NativeExportStorage.identity(url) == file.identity,
        try NativeExportStorage.hash(url) == file.hash
      else {
        throw NativeExportError.message("A private capture changed; its files were preserved.")
      }
    }
    try FileManager.default.removeItem(at: root)
    try NativeExportStorage.syncDirectory(root.deletingLastPathComponent())
  }
}
