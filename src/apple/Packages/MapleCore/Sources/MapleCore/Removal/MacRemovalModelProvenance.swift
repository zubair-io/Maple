#if os(macOS)
  import CryptoKit
  import Foundation

  /// Retains opaque bundle documents, without interpreting or trusting their
  /// distribution/model claims. Inference still requires the store's hard pins.
  /// The receipt is an Apple-local byte inventory, not the portable bundle schema.
  enum MacRemovalModelProvenance {
    private struct Document {
      let file: String
      let url: URL
    }
    private struct Entry: Codable {
      let file: String
      let size: UInt64
      let sha256: String
    }

    private static let maxFiles = 128
    private static let maxFileBytes: UInt64 = 8 << 20
    private static let maxTotalBytes: UInt64 = 16 << 20
    private static let maxReceiptBytes = 1 << 20
    private static let maxSnapshots = 32

    /// Plain local-model imports remain supported. Once either document surface
    /// exists, require both; reject links/special files and snapshot every byte.
    static func stage(from source: URL, in staging: URL) throws -> URL? {
      let fm = FileManager.default
      let base = source.resolvingSymlinksInPath().standardizedFileURL
      let bundle = base.appendingPathComponent("bundle.json")
      let provenance = base.appendingPathComponent("provenance", isDirectory: true)
      let hasBundle = (try? fm.attributesOfItem(atPath: bundle.path)) != nil
      let hasProvenance = (try? fm.attributesOfItem(atPath: provenance.path)) != nil
      guard hasBundle || hasProvenance else { return nil }
      guard try MacRemovalModelFiles.type(at: bundle) == .typeRegular,
        try MacRemovalModelFiles.type(at: provenance) == .typeDirectory
      else { throw RemovalError.invalid("Import the complete model bundle and provenance folder") }
      let documents = try descendants(of: provenance)
      guard !documents.isEmpty else { throw RemovalError.invalid("Bundle provenance is empty") }
      let inputs =
        ([Document(file: "bundle.json", url: bundle)]
        + documents.map {
          Document(file: "provenance/" + $0.file, url: $0.url)
        }).sorted { $0.file < $1.file }
      guard inputs.count <= maxFiles else {
        throw RemovalError.invalid("Too many bundle documents")
      }
      let snapshot = staging.appendingPathComponent("document-snapshot", isDirectory: true)
      try fm.createDirectory(at: snapshot, withIntermediateDirectories: false)
      var total: UInt64 = 0
      let entries = try inputs.map { document in
        try Task.checkCancellation()
        let relative = document.file
        let url = document.url
        try validatePath(relative)
        let size = try sizeOfRegularFile(url)
        guard size <= maxFileBytes, total <= maxTotalBytes - size else {
          throw RemovalError.invalid("Bundle documents exceed the storage limit")
        }
        total += size
        let target = snapshot.appendingPathComponent(relative)
        try fm.createDirectory(
          at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try MacRemovalModelFiles.copy(from: url, to: target, limit: size)
        guard try sizeOfRegularFile(target) == size else {
          throw RemovalError.invalid("\(relative): bundle document changed during import")
        }
        return Entry(
          file: relative, size: size, sha256: try PanoProvisioner.sha256Hex(ofFileAt: target))
      }
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.sortedKeys]
      let receipt = try encoder.encode(entries)
      guard receipt.count <= maxReceiptBytes else {
        throw RemovalError.invalid("Bundle receipt is too large")
      }
      try receipt.write(to: snapshot.appendingPathComponent("receipt.json"), options: .atomic)
      let identified = staging.appendingPathComponent(digest(receipt), isDirectory: true)
      try fm.moveItem(at: snapshot, to: identified)
      try verifySnapshot(identified)
      return identified
    }

    static func publish(_ snapshot: URL, beside models: URL) throws {
      try Task.checkCancellation()
      let fm = FileManager.default
      let root = models.appendingPathComponent("bundles", isDirectory: true)
      if fm.fileExists(atPath: root.path) {
        guard try MacRemovalModelFiles.type(at: root) == .typeDirectory else {
          throw RemovalError.invalid("Installed model provenance is not a directory")
        }
      } else {
        try fm.createDirectory(at: root, withIntermediateDirectories: false)
      }
      let destination = root.appendingPathComponent(snapshot.lastPathComponent, isDirectory: true)
      if fm.fileExists(atPath: destination.path) {
        if (try? verifySnapshot(destination)) == nil {
          _ = try fm.replaceItemAt(destination, withItemAt: snapshot)
        }
      } else {
        try fm.moveItem(at: snapshot, to: destination)
      }
      try verifySnapshot(destination)
      let snapshots = try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
      guard snapshots.count <= maxSnapshots else {
        throw RemovalError.invalid("Too many installed model bundles")
      }
      for existing in snapshots { try verifySnapshot(existing) }
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.sortedKeys]
      let index = try encoder.encode(snapshots.map(\.lastPathComponent).sorted())
      try Task.checkCancellation()
      try index.write(to: models.appendingPathComponent("bundle-receipts.json"), options: .atomic)
    }

    static func verifyInstalled(beside models: URL) throws {
      let root = models.appendingPathComponent("bundles", isDirectory: true)
      let indexURL = models.appendingPathComponent("bundle-receipts.json")
      let fm = FileManager.default
      let hasRoot = (try? fm.attributesOfItem(atPath: root.path)) != nil
      let hasIndex = (try? fm.attributesOfItem(atPath: indexURL.path)) != nil
      guard hasRoot || hasIndex else { return }
      guard try MacRemovalModelFiles.type(at: root) == .typeDirectory else {
        throw RemovalError.invalid("Installed model provenance is not a directory")
      }
      guard try sizeOfRegularFile(indexURL) <= UInt64(maxReceiptBytes) else {
        throw RemovalError.invalid("Installed bundle index is too large")
      }
      let names = try JSONDecoder().decode([String].self, from: Data(contentsOf: indexURL))
      guard !names.isEmpty, names.count <= maxSnapshots, Set(names).count == names.count else {
        throw RemovalError.invalid("Installed bundle index is invalid")
      }
      let snapshots = try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
      guard Set(snapshots.map(\.lastPathComponent)) == Set(names) else {
        throw RemovalError.invalid("Installed model provenance is missing or unindexed")
      }
      for snapshot in snapshots { try verifySnapshot(snapshot) }
    }

    private static func verifySnapshot(_ snapshot: URL) throws {
      try Task.checkCancellation()
      guard try MacRemovalModelFiles.type(at: snapshot) == .typeDirectory else {
        throw RemovalError.invalid("Installed bundle snapshot is not a directory")
      }
      let receiptURL = snapshot.appendingPathComponent("receipt.json")
      guard try sizeOfRegularFile(receiptURL) <= UInt64(maxReceiptBytes) else {
        throw RemovalError.invalid("Installed bundle receipt is too large")
      }
      let receipt = try Data(contentsOf: receiptURL)
      guard digest(receipt) == snapshot.lastPathComponent else {
        throw RemovalError.invalid("Installed bundle receipt checksum mismatch")
      }
      let entries = try JSONDecoder().decode([Entry].self, from: receipt)
      let names = Set(entries.map(\.file))
      guard entries.count <= maxFiles, names.count == entries.count,
        names.contains("bundle.json"), entries.count > 1
      else { throw RemovalError.invalid("Installed bundle receipt is incomplete") }
      var total: UInt64 = 0
      for entry in entries {
        try validatePath(entry.file)
        guard entry.size <= maxFileBytes, total <= maxTotalBytes - entry.size else {
          throw RemovalError.invalid("Installed bundle documents exceed the storage limit")
        }
        total += entry.size
        let url = snapshot.appendingPathComponent(entry.file)
        try verifyParents(of: entry.file, below: snapshot)
        guard try sizeOfRegularFile(url) == entry.size,
          try PanoProvisioner.sha256Hex(ofFileAt: url) == entry.sha256
        else { throw RemovalError.invalid("\(entry.file): installed provenance checksum mismatch") }
      }
      let actual = Set(try descendants(of: snapshot).map(\.file))
      guard actual == names.union(["receipt.json"]) else {
        throw RemovalError.invalid("Installed bundle document inventory changed")
      }
    }

    private static func descendants(of directory: URL) throws -> [Document] {
      var files: [Document] = []
      var visited = 0
      func visit(_ directory: URL, prefix: String, depth: Int) throws {
        try Task.checkCancellation()
        let children = try FileManager.default.contentsOfDirectory(
          at: directory, includingPropertiesForKeys: nil)
        for child in children {
          let relative = prefix + child.lastPathComponent
          visited += 1
          guard visited <= maxFiles * 8 else {
            throw RemovalError.invalid("Too many bundle entries")
          }
          switch try MacRemovalModelFiles.type(at: child) {
          case .typeRegular:
            guard files.count < maxFiles + 1 else {
              throw RemovalError.invalid("Too many bundle documents")
            }
            files.append(Document(file: relative, url: child))
          case .typeDirectory:
            guard depth < 7 else {
              throw RemovalError.invalid("Bundle document directory is too deep")
            }
            try visit(child, prefix: relative + "/", depth: depth + 1)
          default:
            throw RemovalError.invalid("Bundle documents must be regular files and directories")
          }
        }
      }
      try visit(directory, prefix: "", depth: 0)
      return files
    }

    private static func validatePath(_ path: String) throws {
      let parts = path.split(separator: "/", omittingEmptySubsequences: false)
      guard path.utf8.count <= 512, parts.count <= 8,
        parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\\") }),
        path == "bundle.json" || (parts.first == "provenance" && parts.count > 1)
      else { throw RemovalError.invalid("Unsafe bundle document path: \(path.debugDescription)") }
    }

    private static func verifyParents(of file: String, below root: URL) throws {
      var parent = root
      for component in file.split(separator: "/").dropLast() {
        parent = parent.appendingPathComponent(String(component), isDirectory: true)
        guard try MacRemovalModelFiles.type(at: parent) == .typeDirectory
        else { throw RemovalError.invalid("Installed bundle directory was replaced") }
      }
    }

    private static func sizeOfRegularFile(_ url: URL) throws -> UInt64 {
      let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
      guard attributes[.type] as? FileAttributeType == .typeRegular,
        let size = attributes[.size] as? UInt64
      else {
        throw RemovalError.invalid(
          "\(url.lastPathComponent): bundle document is not a regular file")
      }
      return size
    }

    private static func digest(_ bytes: Data) -> String {
      SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
  }
#endif
