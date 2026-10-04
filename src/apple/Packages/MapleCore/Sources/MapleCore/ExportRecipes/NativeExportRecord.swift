import Foundation

public struct NativeExportSource: Codable, Equatable, Sendable {
  public let id: String
  public let url: URL
  public internal(set) var scopeURL: URL?
  public internal(set) var bookmark: Data?
  public internal(set) var relativePath: String?
  public let originalHash: String
  public let identity: String
  /// An explicitly chosen unchanged source can have a new inode; retain the original proof.
  public internal(set) var authorizedIdentity: String? = nil
  /// Non-file adapters are captured once into the queue's private storage.
  public let ownedDirectory: UUID?
}

public struct NativeExportTarget: Codable, Equatable, Sendable {
  public let source: NativeExportSource
  public let stem: String
  public let xmp: String
  public let capturedAt: String?
  public let index: UInt64
}

public struct NativeExportItem: Codable, Equatable, Sendable, Identifiable {
  public var id: String { target.source.id }
  public let target: NativeExportTarget
  public internal(set) var status: String = "pending"
  public internal(set) var reason: String?
  public internal(set) var output: URL?
  public internal(set) var staging: URL?
  public internal(set) var beforeHash: String?
  public internal(set) var afterHash: String?
  public internal(set) var stagingIdentity: String?
}

public struct NativeExportRecord: Codable, Equatable, Sendable {
  public let version: UInt32
  public let id: UUID
  public let recipe: ExportRecipe
  public internal(set) var destinationBookmark: Data
  /// Required, immutable full initial selection; failed-only retries never narrow this.
  public internal(set) var originals: [NativeExportSource]
  public let filmDirectory: URL?
  public let filmHashes: [String: String]
  public internal(set) var items: [NativeExportItem]
  public internal(set) var phase: String = "queued"
  public internal(set) var cancelRequested = false
  var ownedJob: NativeExportOwnedJob?
  var retiredJobs: [NativeExportOwnedJob]?

  public var processed: Int {
    items.filter { ["applied", "failed", "skipped"].contains($0.status) }.count
  }
  public var remaining: Int { items.count - processed }
  public var failures: Int { items.filter { $0.status == "failed" }.count }
  public var successes: Int { items.filter { $0.status == "applied" }.count }

  func validate() throws {
    guard version == 1, !originals.isEmpty, originals.count <= 2000,
      !items.isEmpty, items.count <= 2000,
      Set(originals.map(\.id)).count == originals.count,
      Set(items.map(\.id)).count == items.count,
      items.allSatisfy({ originals.contains($0.target.source) }),
      items.allSatisfy({
        ["pending", "rendering", "prepared", "applied", "failed", "skipped"].contains($0.status)
      })
    else {
      throw NativeExportError.message(
        "The saved export has incomplete original identities or an invalid ledger. Start a new export from the full selection."
      )
    }
    func validHash(_ value: String) -> Bool {
      value.count == 64
        && value.allSatisfy { $0.isASCII && ($0.isNumber || ("a"..."f").contains(String($0))) }
    }
    guard
      originals.allSatisfy({
        $0.url.isFileURL && validHash($0.originalHash) && !$0.identity.isEmpty
          && ($0.authorizedIdentity.map { !$0.isEmpty } ?? true)
      }),
      items.allSatisfy({ item in
        !["rendering", "prepared", "applied"].contains(item.status)
          || (item.output != nil && item.staging != nil
            && (item.status == "rendering"
              || (item.afterHash.map(validHash) == true && item.stagingIdentity != nil)))
      }), ["queued", "running", "interrupted", "cancelled", "done"].contains(phase)
    else {
      throw NativeExportError.message(
        "Saved export has incomplete byte proofs. Start a new export from the full selection.")
    }
    for job in [ownedJob].compactMap({ $0 }) + (retiredJobs ?? []) {
      guard !job.identity.isEmpty, Set(job.files.map(\.path)).count == job.files.count,
        job.files.allSatisfy({ file in
          let pieces = file.path.split(separator: "/", omittingEmptySubsequences: false)
          return pieces.count == 2 && ["Sources", "Film"].contains(String(pieces[0]))
            && !pieces[1].isEmpty && pieces[1] != "." && pieces[1] != ".."
            && validHash(file.hash) && !file.identity.isEmpty
        })
      else {
        throw NativeExportError.message("Private capture retirement has invalid ownership proofs.")
      }
    }
    try NativeExportRecipeBridge.validate(recipe)
    guard recipe.destination == "directory" else {
      throw NativeExportError.message("Choose a destination folder for native recipe export.")
    }
  }
}

public struct SavedNativeExportRecipe: Codable, Equatable, Sendable, Identifiable {
  public let id: UUID
  public var recipe: ExportRecipe
  public var destinationBookmark: Data?
  public init(id: UUID = UUID(), recipe: ExportRecipe, destinationBookmark: Data? = nil) {
    self.id = id
    self.recipe = recipe
    self.destinationBookmark = destinationBookmark
  }
}
