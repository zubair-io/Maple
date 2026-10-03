#if os(macOS)
  import CryptoKit
  import Foundation

  /// App-owned, offline installation of the experimental pins (#1472 / #3941).
  /// Import is explicit; no model download or release qualification is implied.
  actor MacRemovalModelStore {
    struct Artifact: Sendable {
      let file: String
      let sha256: String
      let size: UInt64?
    }

    static let shared = MacRemovalModelStore()
    private let root: URL
    private let artifacts: [Artifact]
    private let directory: URL

    private init() {
      self.init(
        root: URL.applicationSupportDirectory.appendingPathComponent(
          "app.justmaple.aperture/removal-models", isDirectory: true))
    }

    init(root: URL) {
      let models = ExperimentalRemovalModels.all.map {
        Artifact(file: $0.file, sha256: $0.sha256, size: $0.size)
      }
      guard let runtime = PanoProvisionManifest.ortRuntime,
        case .ortTarball(_, let digest) = runtime.kind
      else { preconditionFailure("macOS requires the pinned ONNX Runtime") }
      self.init(
        root: root,
        artifacts: models + [Artifact(file: "runtime.dylib", sha256: digest, size: nil)])
    }

    /// Isolated destinations and byte pins let filesystem tests avoid user data.
    init(root: URL, artifacts: [Artifact]) {
      precondition(root.isFileURL && !artifacts.isEmpty)
      precondition(artifacts.allSatisfy { !$0.file.contains("/") && !$0.file.contains("..") })
      self.root = root
      self.artifacts = artifacts
      let identity = artifacts.map { "\($0.file):\($0.sha256)" }.joined(separator: "\n")
      let version = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }
        .joined()
      directory = root.appendingPathComponent(version, isDirectory: true)
    }

    func installedDirectory() throws -> URL? {
      guard FileManager.default.fileExists(atPath: directory.path) else { return nil }
      for artifact in artifacts {
        try verify(artifact, at: directory.appendingPathComponent(artifact.file))
      }
      return directory
    }

    /// Stage and verify the entire set before publishing any file. A failed or
    /// cancelled import leaves a valid installation intact. Each replacement is
    /// atomic and has the same pinned bytes; existing mapped model owners survive.
    func install(from source: URL) throws -> URL {
      guard source.isFileURL else { throw RemovalError.invalid("Choose a local model folder") }
      let scope = RemovalSecurityScope(source)
      defer { withExtendedLifetime(scope) {} }
      try Task.checkCancellation()
      let fm = FileManager.default
      try fm.createDirectory(at: root, withIntermediateDirectories: true)
      let staging = root.appendingPathComponent(".import-\(UUID().uuidString)", isDirectory: true)
      try fm.createDirectory(at: staging, withIntermediateDirectories: false)
      defer { try? fm.removeItem(at: staging) }
      for artifact in artifacts {
        let target = staging.appendingPathComponent(artifact.file)
        try copyBytes(from: source.appendingPathComponent(artifact.file), to: target)
        try verify(artifact, at: target)
      }
      try Task.checkCancellation()
      try fm.createDirectory(at: directory, withIntermediateDirectories: true)
      for artifact in artifacts {
        let target = directory.appendingPathComponent(artifact.file)
        if (try? verify(artifact, at: target)) != nil { continue }
        let staged = staging.appendingPathComponent(artifact.file)
        if fm.fileExists(atPath: target.path) {
          _ = try fm.replaceItemAt(target, withItemAt: staged)
        } else {
          try fm.moveItem(at: staged, to: target)
        }
      }
      // A partial I/O failure is never reported as ready. The next explicit
      // import repairs missing/corrupt files; loaders also verify pins on use.
      guard let installed = try installedDirectory() else {
        throw RemovalError.invalid("Local model installation disappeared; import it again")
      }
      return installed
    }

    private func verify(_ artifact: Artifact, at url: URL) throws {
      try Task.checkCancellation()
      let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
      guard attributes[.type] as? FileAttributeType == .typeRegular,
        artifact.size == nil || (attributes[.size] as? UInt64) == artifact.size,
        try PanoProvisioner.sha256Hex(ofFileAt: url) == artifact.sha256
      else { throw RemovalError.invalid("\(artifact.file): model checksum or size mismatch") }
    }

    /// Dereference imported symlinks and bound transient memory to one MiB.
    /// The installed files must survive removal of the external model folder.
    private func copyBytes(from source: URL, to target: URL) throws {
      let input = try FileHandle(forReadingFrom: source)
      defer { try? input.close() }
      guard FileManager.default.createFile(atPath: target.path, contents: nil) else {
        throw RemovalError.invalid("Could not stage \(target.lastPathComponent)")
      }
      let output = try FileHandle(forWritingTo: target)
      defer { try? output.close() }
      while let bytes = try input.read(upToCount: 1 << 20), !bytes.isEmpty {
        try Task.checkCancellation()
        try output.write(contentsOf: bytes)
      }
      try output.synchronize()
    }
  }
#endif
