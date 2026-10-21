// SMBSource.swift — SMB 2/3 source adapter via AMSMB2.
//
// Provides read access to RAW files on an SMB share (NAS / Samba server).
// XMP sidecar writes are retried with exponential back-off.
//
// The listing call recursively walks the connected share root and surfaces
// every RAW file regardless of folder depth, because the typical NAS layout
// is `/Photos/<event>/<file>.dng` and a non-recursive root scan returns
// nothing on shares that contain only sub-folders at the top level.
//
// AMSMB2 v4 API notes:
//   - contentsOfDirectory returns [[URLResourceKey: Any]] — use .nameKey, .isDirectoryKey, .pathKey
//   - contents(atPath:range:) returns Data directly
//   - write(data:toPath:progress:) async throws
//   - disconnectShare(gracefully:) async throws
//
// AMSMB2 license: MIT (review before App Store submission).

import AMSMB2
import Foundation

// MARK: - SMBSource

/// Access RAW files on an SMB 2/3 share.
public actor SMBSource {

  // MARK: Types

  public struct SMBAsset: Sendable, Identifiable, Hashable {
    public let id: UUID
    public let path: String  // share-relative path, e.g. "/Photos/IMG_001.dng"
    /// Size + mtime as reported by the directory listing that discovered
    /// this asset (`listRAWFiles`'s `.fileSizeKey`/
    /// `.contentModificationDateKey`, both populated by AMSMB2's
    /// `stat.populateResourceValue`). Captured here so maple_id
    /// cache-validity checks (#1995) don't need a second
    /// `attributesOfItem` round-trip per asset — the listing already
    /// paid for this.
    public let size: Int64
    public let mtime: Date
    public var name: String { (path as NSString).lastPathComponent }

    public init(path: String, size: Int64 = 0, mtime: Date = .distantPast) {
      self.id = UUID()
      self.path = path
      self.size = size
      self.mtime = mtime
    }
  }

  public struct Credentials: Sendable {
    public let host: String
    public let share: String
    public let username: String
    public let password: String

    public init(host: String, share: String, username: String, password: String) {
      self.host = host
      self.share = share
      self.username = username
      self.password = password
    }
  }

  // MARK: State

  // Not `private`: `SMBSource+Thumbs.swift` (#2690) reads this too.
  var client: SMB2Manager?
  private var credentials: Credentials?
  private var _assets: [SMBAsset] = []
  private(set) var listingID = UUID()

  /// Per-share maple_id cache (#1995), rooted at the connected
  /// `remotePath` — `<remotePath>/.maple/id-cache-apple.json`. `nil` until
  /// `connect` succeeds; reset to `nil` in `disconnect()`.
  private var idCache: MapleIdCacheStore?

  /// maple_id (hex) -> share-relative path, populated as a side effect of
  /// `images()` (#1995). Before #1995, `ImageRef.id` WAS the share-relative
  /// path, so `rawBytes(for:)`/`writeXMP(for:)` could read `ref.id`
  /// directly as an SMB path. Now that `id` is the content-addressed
  /// maple_id, those two methods need this map to recover the actual path
  /// — every `ImageRef` a caller can hold for this source necessarily came
  /// from a prior `images()` call (SMB has no other id-issuing entry
  /// point: `search()` returns `nil`), so the map is always populated by
  /// the time a caller round-trips a ref back into `rawBytes`/`writeXMP`.
  private(set) var pathByMapleId: [String: String] = [:]
  /// maple_ids listed at more than one path: byte-identical copies (#4705).
  private(set) var ambiguousMapleIds: Set<String> = []
  private(set) var relocatedPaths: [ImageRef: String] = [:]

  /// First 64 KB of a file — the bound the primary-form head hash reads.
  /// Matches `raw_core::SHA1_HEAD_BYTES` (`id.rs`) and
  /// `FilesystemSource.mapleIdHeadByteCount`; duplicated as a literal
  /// rather than threaded across the FFI boundary for a single integer.
  static let mapleIdHeadByteCount = 64 * 1024

  public var assets: [SMBAsset] { _assets }

  public init() {}

  // MARK: Public API

  /// Connect to an SMB share and enumerate RAW files in a path.
  public func connect(credentials: Credentials, remotePath: String = "/") async throws {
    guard let serverURL = URL(string: "smb://\(credentials.host)") else {
      throw SMBError.invalidServerURL(credentials.host)
    }

    let cred = URLCredential(
      user: credentials.username,
      password: credentials.password,
      persistence: .forSession
    )
    guard let mgr = SMB2Manager(url: serverURL, credential: cred) else {
      throw SMBError.invalidServerURL(credentials.host)
    }

    try await mgr.connectShare(name: credentials.share)
    let listed: [SMBAsset]
    do { listed = try await listRAWFiles(at: remotePath, client: mgr) } catch {
      try? await mgr.disconnectShare(gracefully: false)
      throw error
    }
    // One unsuspended swap, compared against the connection live NOW (a concurrent connect
    // may have finished meanwhile): no reentrant call mixes two shares' state. Another share
    // retires every earlier ref; an address change alone keeps them (#4987).
    let switchesShare =
      self.credentials?.share != credentials.share
      || self.credentials?.username != credentials.username
    let switchesServer = switchesShare || self.credentials?.host != credentials.host
    if switchesServer { relocatedPaths = [:] }
    if switchesShare { listingID = UUID() }
    self.credentials = credentials
    self.client = mgr
    _assets = listed
    self.idCache = MapleIdCacheStore(
      storage: SMBIdCacheStorage(client: mgr, remotePath: remotePath))
  }

  /// Disconnect from the share.
  public func disconnect() async {
    // #4110: publications and streams must release their handles before context teardown.
    let retiringClient = client
    client = nil
    idCache = nil
    pathByMapleId = [:]
    ambiguousMapleIds = []
    try? await retiringClient?.disconnectShare(gracefully: true)
  }

  // createFolder(named:in:) / createFolderAtShareRoot / listSubdirectories
  // / renameFolder / trashFolder — folder CRUD for the sidebar's SMB tree
  // — live in SMBSource+Folders.swift (file-budget split, #2697).

  /// Read raw bytes of an asset over SMB.
  public func rawData(for asset: SMBAsset) async throws -> Data {
    guard let client else { throw SMBError.notConnected }
    return try await client.contents(atPath: asset.path, range: Range<UInt64>?.none)
  }

  /// Rename `ref`'s file in place (same directory, new filename) — routes
  /// through the merged `SMBFileOperations.relocate` engine (#2631/#2638),
  /// which already handles the same-file guard, the case-only-rename fast
  /// path, and following the `.xmp` sidecar. `collision` defaults to
  /// `.fail`: the single-asset inline-rename entry point is a
  /// user-initiated action from an inline text field, not an unattended
  /// background move, so a name collision surfaces as an error the caller
  /// shows inline rather than silently auto-suffixing. The batch rename
  /// flow (#2641) passes the user's chosen collision policy explicitly
  /// instead — `collision` is caller-supplied so this one method serves
  /// both callers rather than each hard-coding its own policy.
  ///
  /// Records the relocation and updates the matching `_assets` entry so the
  /// asset's ALREADY-CAPTURED `bytesProvider` closure keeps resolving to the
  /// right file (`path(for:)` is evaluated at read time), and the next
  /// `images()` call reflects the new name without a full re-list.
  public func renameAsset(
    _ ref: ImageRef, to newFilename: String, collision: CollisionPolicy = .fail
  ) async throws -> String {
    guard let client else { throw SMBError.notConnected }
    let sourcePath = try mutationPath(for: ref)
    let identity = listingID
    let destinationDir = (sourcePath as NSString).deletingLastPathComponent
    let outcome = try await SMBFileOperations.relocate(
      sourcePath, to: destinationDir, newBasename: newFilename,
      mode: .move, collision: collision, transport: client)
    guard recordRelocation(ref, from: sourcePath, to: outcome.primaryPath, listedAs: identity)
    else { return outcome.primaryPath }
    if let idx = _assets.firstIndex(where: { $0.path == sourcePath }) {
      let old = _assets[idx]
      _assets[idx] = SMBAsset(path: outcome.primaryPath, size: old.size, mtime: old.mtime)
    }
    return outcome.primaryPath
  }

  /// Move or copy `ref`'s file into `destinationDir` (a share-relative
  /// directory, e.g. `"/"` for the share root) — the drag-onto-source-tree
  /// counterpart to `renameAsset` above (#2646). Same `pathByMapleId`/
  /// `_assets` reconciliation, and a no-op for `mode: .copy` (the source
  /// entry keeps pointing at the original, matching the API's "copy never
  /// repoints the source" contract for Cloud — see
  /// `relocateAsset` in `RemoteCatalog.swift`).
  public func relocateAsset(
    _ ref: ImageRef, to destinationDir: String, mode: RelocateMode, collision: CollisionPolicy
  ) async throws -> RelocateOutcome {
    guard let client else { throw SMBError.notConnected }
    let sourcePath = try mutationPath(for: ref)
    let identity = listingID
    let outcome = try await SMBFileOperations.relocate(
      sourcePath, to: destinationDir, mode: mode, collision: collision, transport: client)
    guard mode == .move,
      recordRelocation(ref, from: sourcePath, to: outcome.primaryPath, listedAs: identity)
    else { return outcome }
    if let idx = _assets.firstIndex(where: { $0.path == sourcePath }) {
      let old = _assets[idx]
      _assets[idx] = SMBAsset(path: outcome.primaryPath, size: old.size, mtime: old.mtime)
    }
    return outcome
  }

  // MARK: - Trash / restore (#2653)

  /// Trash `ref`'s file into `.maple/trash/<rel>` (SMB has no OS-trash
  /// concept to call into — see `SMBFileOperations+Trash.swift`'s file
  /// header). Same `pathByMapleId`/`_assets` reconciliation as
  /// `relocateAsset`'s move branch.
  public func trashAsset(_ ref: ImageRef) async throws -> RelocateOutcome {
    guard let client else { throw SMBError.notConnected }
    let sourcePath = try mutationPath(for: ref)
    let identity = listingID
    let outcome = try await SMBFileOperations.trash(sourcePath, transport: client)
    guard recordRelocation(ref, from: sourcePath, to: outcome.primaryPath, listedAs: identity)
    else { return outcome }
    _assets.removeAll { $0.path == sourcePath }
    return outcome
  }

  /// Every item currently sitting in this share's `.maple/trash` — backs
  /// the in-app Trash browser for SMB sources.
  public func listTrash() async throws -> [TrashedItem] {
    guard let client else { throw SMBError.notConnected }
    return await SMBFileOperations.listMapleTrash(transport: client)
  }

  /// Restore a trashed item to its original location.
  public func restoreFromTrash(_ item: TrashedItem) async throws -> RelocateOutcome {
    guard let client else { throw SMBError.notConnected }
    return try await SMBFileOperations.restoreFromMapleTrash(item.primaryPath, transport: client)
  }

  /// Permanently delete a trashed item — no further recovery.
  public func permanentlyDelete(_ item: TrashedItem) async throws {
    guard let client else { throw SMBError.notConnected }
    try await SMBFileOperations.permanentlyDeleteFromMapleTrash(item, transport: client)
  }

  /// Purges every `.maple/trash` item ≥30 days old. Called from the app's
  /// debounced daily sweep (`AppShell+Trash.swift`) whenever an SMB share
  /// is the connected source.
  @discardableResult
  public func sweepExpiredTrash(olderThanDays: Int = 30) async -> Int {
    guard let client else { return 0 }
    return await SMBFileOperations.sweepExpiredMapleTrash(
      olderThanDays: olderThanDays, transport: client)
  }

  /// Write XMP sidecar bytes over SMB with retry (3 attempts, exponential back-off).
  public func writeSidecar(_ data: Data, for asset: SMBAsset) async throws {
    guard let client else { throw SMBError.notConnected }
    let sidecarPath = SMBFileOperations.sidecarPath(for: asset.path)
    try await writeWithRetry(data: data, to: sidecarPath, client: client)
  }

  // MARK: Private

  /// Recursively enumerate RAW files under `path`. AMSMB2's `recursive: true`
  /// flag walks the whole subtree in one round-trip and stamps each entry's
  /// `.pathKey` with its full share-relative path (e.g.
  /// `/Photos/2024/IMG_001.dng`). Directories and dotfiles are skipped.
  ///
  /// Recursive enumeration matches the user's expectation that "open the
  /// share, see all my photos" works regardless of whether the RAWs sit at
  /// the share root or three folders deep — the prior non-recursive walk
  /// returned an empty list whenever the root contained only sub-folders,
  /// which is the common NAS layout (`/Photos/`, `/Backups/`, etc.).
  private func listRAWFiles(at path: String, client: SMB2Manager) async throws -> [SMBAsset] {
    let entries = try await client.contentsOfDirectory(atPath: path, recursive: true)
    return entries.compactMap { attrs -> SMBAsset? in
      guard let name = attrs[.nameKey] as? String else { return nil }
      let isDir = attrs[.isDirectoryKey] as? Bool ?? false
      guard !isDir else { return nil }
      let ext = (name as NSString).pathExtension.lowercased()
      guard SupportedImageExtensions.all.contains(ext) else { return nil }
      // `.pathKey` is the full share-relative path stamped by AMSMB2's
      // recursive walk; fall back to joining `path + name` when the
      // server didn't populate it (non-recursive root scan).
      let fullPath =
        (attrs[.pathKey] as? String)
        ?? (path as NSString).appendingPathComponent(name)
      // Exclude private staging dirs and dotfiles relative to root (#4309).
      if SMBSource.hasHiddenPathComponent(in: fullPath, relativeTo: path) { return nil }
      // `.fileSizeKey` / `.contentModificationDateKey` are populated by
      // AMSMB2's `stat.populateResourceValue` on every directory-listing
      // entry (see `FileHandle.swift` in the vendored AMSMB2 checkout) —
      // capture them now so maple_id cache-validity checks (#1995)
      // don't need a second per-asset round-trip.
      let size = (attrs[.fileSizeKey] as? NSNumber)?.int64Value ?? 0
      let mtime = attrs[.contentModificationDateKey] as? Date ?? .distantPast
      return SMBAsset(path: fullPath, size: size, mtime: mtime)
    }.sorted { $0.path < $1.path }
  }

  private func writeWithRetry(
    data: Data, to path: String, client: SMB2Manager,
    maxAttempts: Int = 3
  ) async throws {
    var lastError: Error?
    for attempt in 0..<maxAttempts {
      do {
        _ = try await client.publishSidecar(atPath: path) { current in
          let incoming = String(decoding: data, as: UTF8.self)
          _ = try XMPParser.parse(incoming)
          let candidate = try WorkflowSidecarCore.variantWorkflow(
            xmp: incoming, variantId: WorkflowContract.primaryVariantID)
          guard let current else { return data }
          let confirmed = String(decoding: current, as: UTF8.self)
          _ = try XMPParser.parse(confirmed)
          guard
            let record = try WorkflowSidecarCore.variantWorkflow(
              xmp: confirmed, variantId: WorkflowContract.primaryVariantID)
          else {
            return data
          }
          guard candidate == nil || candidate == record else {
            throw WorkflowSidecarError(message: "Workflow changed. Refresh before saving.")
          }
          return Data(try WorkflowSidecarCore.embed(record, in: incoming).utf8)
        }
        return
      } catch let error as WorkflowSidecarError {
        // A changed semantic workflow requires refresh, not a network retry.
        throw error
      } catch {
        lastError = error
        if attempt < maxAttempts - 1 {
          let delay = UInt64(pow(2.0, Double(attempt))) * 1_000_000_000
          try await Task.sleep(nanoseconds: delay)
        }
      }
    }
    throw lastError ?? SMBError.writeFailedAfterRetries
  }
}

// MARK: - SMBIdCacheStorage

/// AMSMB2-backed `MapleIdCacheStorage` (#1995) for an SMB share. Mirrors
/// `LocalIdCacheStorage`'s contract exactly, routed through `SMB2Manager`
/// instead of `FileManager` — the id-cache files live ON THE SHARE (at
/// `<remotePath>/.maple/id-cache-*.json`), so a Mac app and a Web Hosted tab
/// browsing the same NAS folder can see each other's cached ids.
struct SMBIdCacheStorage: MapleIdCacheStorage {
  private let client: SMB2Manager
  private let mapleDirPath: String

  init(client: SMB2Manager, remotePath: String) {
    self.client = client
    self.mapleDirPath = (remotePath as NSString).appendingPathComponent(".maple")
  }

  private func filePath(_ name: String) -> String {
    (mapleDirPath as NSString).appendingPathComponent(name)
  }

  func ensureDirectory() async {
    // "Already exists" is not an error from this call's perspective —
    // matches `LocalIdCacheStorage.ensureDirectory`'s `try?`.
    try? await client.createDirectory(atPath: mapleDirPath)
  }

  func listIdCacheFileNames() async -> [String] {
    guard
      let entries = try? await client.contentsOfDirectory(atPath: mapleDirPath, recursive: false)
    else { return [] }
    return
      entries
      .compactMap { $0[.nameKey] as? String }
      .filter { $0.hasPrefix("id-cache-") && $0.hasSuffix(".json") }
  }

  func readIdCacheFile(name: String) async -> Data? {
    try? await client.contents(atPath: filePath(name))
  }

  func writeIdCacheFile(name: String, data: Data) async {
    // Temp-file-then-rename rather than a direct write to the final
    // path: a dropped SMB connection mid-write would otherwise leave a
    // truncated/corrupt id-cache file that other readers could observe.
    // With temp+rename, a drop mid-write only corrupts the temp file —
    // the previously-good final file is untouched until the rename.
    //
    // SMB2 rename (`moveItem`) is not guaranteed to overwrite an
    // existing destination (server-dependent `ReplaceIfExists`
    // semantics) — best-effort remove the previous file first so the
    // rename that follows lands cleanly; "didn't exist yet" is the
    // expected outcome on a first write and its failure is swallowed.
    let tmpPath = filePath(".\(name).tmp-\(UUID().uuidString)")
    let finalPath = filePath(name)
    do {
      try await client.write(data: data, toPath: tmpPath, progress: nil)
      try? await client.removeItem(atPath: finalPath)
      try await client.moveItem(atPath: tmpPath, toPath: finalPath)
    } catch {
      try? await client.removeItem(atPath: tmpPath)
    }
  }
}

// MARK: - ImageSource conformance

extension SMBSource: ImageSource {
  /// Map enumerated `SMBAsset`s to `ImageRef`. `id` is the spec-form
  /// `maple_id` hex (#1995) — see `FilesystemSource.images()`'s doc
  /// comment for why (content-addressed id shared with the server indexer
  /// and Web, not a source-local path). Falls back to the share-relative
  /// path only when derivation genuinely fails. `url` is left `nil` so
  /// `BrowseViewModel.loadSource` routes byte reads through
  /// `rawBytes(for:)` (the bytes-provider branch) — the Rust decode pipeline
  /// can't open an `smb://` URL as a file URL, so the prior synthetic URL
  /// caused decodes to fail silently downstream.
  public func images() async throws -> [ImageRef] {
    // Hashing suspends; a reconnect must not stamp these paths with the next share's id,
    // nor hash them through, or cache them on, the next share's connection (#4987).
    let (identity, client, idCache) = (listingID, client, idCache)
    var refs: [ImageRef] = []
    refs.reserveCapacity(_assets.count)
    var freshPathByMapleId: [String: String] = [:]
    var freshAmbiguousIds: Set<String> = []
    for a in _assets {
      let id = await mapleId(for: a, client: client, idCache: idCache) ?? a.path
      if freshPathByMapleId[id] != nil { freshAmbiguousIds.insert(id) }
      freshPathByMapleId[id] = a.path
      refs.append(ImageRef(id: id, displayName: a.name, smbPath: a.path, smbSourceID: identity))
    }
    guard identity == listingID else { throw CancellationError() }
    pathByMapleId = freshPathByMapleId
    ambiguousMapleIds = freshAmbiguousIds
    // A path listed again holds whatever file is there now, not the one moved away (#4992).
    let listed = Set(_assets.map(\.path))
    relocatedPaths = relocatedPaths.filter { !listed.contains($0.key.smbPath ?? "") }
    return refs
  }

  // thumb(for:)/writeThumb(_:for:) — on-share `.maple/thumbs/` cache
  // (#2690) — live in SMBSource+Thumbs.swift (file-budget split).

  public func preview(for ref: ImageRef) async throws -> Data? { nil }

  public func rawBytes(for ref: ImageRef) async throws -> Data {
    guard let client else { throw SMBError.notConnected }
    return try await client.contents(atPath: path(for: ref), range: Range<UInt64>?.none)
  }

  public func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {
    guard let client else { throw SMBError.notConnected }
    let xml = XMPSerializer.serialize(model: sidecar.model, culling: sidecar.culling)
    guard let data = xml.data(using: .utf8) else {
      throw XMPStoreError.encodingError
    }
    let sidecarPath = SMBFileOperations.sidecarPath(for: try mutationPath(for: ref))
    try await writeWithRetry(data: data, to: sidecarPath, client: client)
  }

  /// `false` when the source moved to another share while the file op ran.
  private func recordRelocation(
    _ ref: ImageRef, from oldPath: String, to newPath: String, listedAs identity: UUID
  ) -> Bool {
    guard identity == listingID else { return false }
    relocatedPaths = relocatedPaths.mapValues { $0 == oldPath ? newPath : $0 }
    relocatedPaths[ref] = newPath
    pathByMapleId[ref.id] = newPath
    return true
  }

  // path(for:) / mutationPath(for:) live in SMBSource+Paths.swift.

  /// SMB shares have no server-side index.
  public func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
}
