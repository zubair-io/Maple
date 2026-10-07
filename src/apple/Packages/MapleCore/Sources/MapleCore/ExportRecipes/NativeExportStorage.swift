import CryptoKit
import Darwin
import Foundation

public actor NativeExportRecipeStore {
  private let directory: URL
  public init(directory: URL? = nil) {
    self.directory =
      directory ?? NativeExportStorage.root().appendingPathComponent("Recipes", isDirectory: true)
  }
  public func list() throws -> [SavedNativeExportRecipe] {
    try files().compactMap(Self.decode)
      .sorted {
        $0.recipe.name.localizedCaseInsensitiveCompare($1.recipe.name) == .orderedAscending
      }
  }
  /// Files that could not be decoded stay on disk untouched and are reported, not hidden.
  public func unreadable() throws -> [String] {
    try files().filter { Self.decode($0) == nil }.map(\.lastPathComponent).sorted()
  }
  private func files() throws -> [URL] {
    guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
    return try FileManager.default.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: nil
    )
    .filter { $0.pathExtension == "json" }
  }
  private static func decode(_ url: URL) -> SavedNativeExportRecipe? {
    try? JSONDecoder().decode(SavedNativeExportRecipe.self, from: Data(contentsOf: url))
  }
  public func save(_ value: SavedNativeExportRecipe) throws {
    let name = value.recipe.name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard value.recipe.schemaVersion == ExportRecipe.defaults.schemaVersion, !name.isEmpty,
      value.recipe.name.count <= 80
    else {
      throw NativeExportError.message("Recipe names must contain 1–80 characters.")
    }
    guard
      try !list().contains(where: {
        $0.id != value.id
          && $0.recipe.name.trimmingCharacters(in: .whitespacesAndNewlines).caseInsensitiveCompare(
            name) == .orderedSame
      })
    else {
      throw NativeExportError.message(
        "A recipe with this name already exists. Choose another name.")
    }
    try NativeExportStorage.write(
      value, to: directory.appendingPathComponent(value.id.uuidString + ".json"))
  }
  public func delete(_ id: UUID) throws {
    try FileManager.default.removeItem(
      at: directory.appendingPathComponent(id.uuidString + ".json"))
  }
}

enum NativeExportStorage {
  static func root() -> URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Maple", isDirectory: true)
      .appendingPathComponent("Exports", isDirectory: true)
  }
  static func write<T: Encodable>(_ value: T, to url: URL) throws {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let temp = url.deletingLastPathComponent().appendingPathComponent(
      ".\(url.lastPathComponent).\(UUID().uuidString).tmp")
    defer { try? FileManager.default.removeItem(at: temp) }
    try encoder.encode(value).write(to: temp, options: .withoutOverwriting)
    let handle = try FileHandle(forWritingTo: temp)
    defer { try? handle.close() }
    try handle.synchronize()
    guard Darwin.rename(temp.path, url.path) == 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    try syncDirectory(url.deletingLastPathComponent())
  }
  static func syncDirectory(_ directory: URL) throws {
    let descriptor = Darwin.open(directory.path, O_RDONLY)
    guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    defer { Darwin.close(descriptor) }
    guard Darwin.fsync(descriptor) == 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
  }
  static func identity(_ url: URL) throws -> String {
    let values = try FileManager.default.attributesOfItem(
      atPath: url.resolvingSymlinksInPath().path)
    guard let device = values[.systemNumber] as? NSNumber,
      let inode = values[.systemFileNumber] as? NSNumber
    else {
      throw NativeExportError.message("Could not prove the original's filesystem identity.")
    }
    return "\(device):\(inode)"
  }
  static func hash(_ url: URL) throws -> String? {
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    let resolved = url.resolvingSymlinksInPath()
    let values = try resolved.resourceValues(forKeys: [.isRegularFileKey])
    guard values.isRegularFile == true else {
      throw NativeExportError.message(
        "Export input, destination or staging must be a regular file.")
    }
    let file = try FileHandle(forReadingFrom: url)
    defer { try? file.close() }
    var hash = SHA256()
    while let data = try file.read(upToCount: 65536), !data.isEmpty { hash.update(data: data) }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
  }
  static func failure(_ error: Error) -> String {
    let value = error as NSError
    let detail = error.localizedDescription.lowercased()
    if detail.contains("(os error 28)")
      || value.domain == NSPOSIXErrorDomain && value.code == Int(ENOSPC)
      || value.code == NSFileWriteOutOfSpaceError
    {
      return "The destination is full. Free space and retry the failed photos."
    }
    if detail.contains("(os error 13)") || detail.contains("(os error 1)")
      || value.domain == NSPOSIXErrorDomain && [Int(EACCES), Int(EPERM)].contains(value.code)
      || [NSFileReadNoPermissionError, NSFileWriteNoPermissionError].contains(value.code)
    {
      return
        "Permission denied. Choose the original and destination folders again, then resume or retry."
    }
    return error.localizedDescription
  }
}
