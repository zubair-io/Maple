// Local sidecar coordination shared by authored and recovery writes (#3940).
import Darwin
import Foundation

extension XMPSidecarStore {
  /// The sidecar text currently on disk, or nil when there is none.
  ///
  /// The write path reads it for the two things a model+culling write must
  /// not destroy: the IPTC/EXIF metadata block, and the passthrough bucket
  /// (#2233). Disk is the carrier for both rather than in-memory state
  /// threaded down from `EditSession`, so an externally-edited sidecar
  /// contributes its current contents instead of a stale snapshot taken at
  /// open time.
  func existingSidecarXML(at url: URL) throws -> String? {
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    return try String(contentsOf: url, encoding: .utf8)
  }

  func requireVariantWorkflow(in xml: String) throws {
    _ = try WorkflowSidecarCore.variantWorkflow(xmp: xml, variantId: variantId)
  }

  func requirePrimaryAbsence() throws {
    guard variantId == WorkflowContract.primaryVariantID else {
      throw WorkflowSidecarError(
        message:
          "Variant sidecar is missing: \(sidecarURL.lastPathComponent). Restore it before editing.")
    }
  }

  /// Cooperate with separate editor/variant store instances on this same file.
  ///
  /// Only a sidecar that carries accepted removal records, a write that
  /// changes them, or a photo another owner has leased before (its lock inode
  /// exists) takes the persistent kernel lease: it is what stops an older
  /// Maple writer from replacing a newer removal (#3940). An ordinary save on
  /// any other photo keeps NSFileCoordinator alone, as before #1472, so no
  /// lock inode is left beside every edited photo and a coordinator-serialized
  /// peer (FileProvider, a variant store) is never refused with `saveConflict`.
  func coordinateSidecarWrite<T>(
    removalChange: Bool = false, _ write: (URL, String?) throws -> T
  ) throws -> T {
    let lockURL = sidecarURL.deletingLastPathComponent().appendingPathComponent(
      ".\(sidecarURL.lastPathComponent).lock")
    let requiresLease =
      removalChange
      || FileManager.default.fileExists(atPath: lockURL.path)
      || ((try? existingSidecarXML(at: sidecarURL))?.contains("InpaintRemovals") ?? false)
    guard requiresLease else { return try coordinateWithoutLease(write) }
    let descriptor = open(lockURL.path, O_CREAT | O_RDWR, 0o600)
    guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    defer { close(descriptor) }
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
      throw RemovalError.saveConflict
    }
    defer { flock(descriptor, LOCK_UN) }
    return try coordinateWithoutLease(write)
  }

  private func coordinateWithoutLease<T>(_ write: (URL, String?) throws -> T) throws -> T {
    let coordinator = NSFileCoordinator(filePresenter: nil)
    var error: NSError?
    var result: Result<T, Error>?
    coordinator.coordinate(writingItemAt: sidecarURL, options: [], error: &error) { url in
      result = Result {
        let existing = try self.existingSidecarXML(at: url)
        if existing == nil { try self.requirePrimaryAbsence() }
        return try write(url, existing)
      }
    }
    if let error { throw error }
    guard let result else {
      throw WorkflowSidecarError(
        message: "Unable to coordinate the sidecar save. Reopen and retry.")
    }
    return try result.get()
  }

}
