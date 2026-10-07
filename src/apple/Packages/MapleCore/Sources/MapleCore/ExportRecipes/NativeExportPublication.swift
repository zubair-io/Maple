import Darwin
import Foundation

/// The ledger owns naming, original guards, exclusive staging and atomic publication (#4113).
enum NativeExportPublication {
  static func prepare(
    _ item: NativeExportItem, record: NativeExportRecord, access: NativeExportAccess
  ) throws -> NativeExportItem {
    guard try sourceMatches(item, access: access) else {
      throw NativeExportError.message(
        "The original identity or bytes changed, or it is missing. Choose the unchanged original again, or start a new export."
      )
    }
    let filename = try NativeExportRecipeBridge.filename(
      record.recipe, stem: item.target.stem, capturedAt: item.target.capturedAt,
      index: item.target.index)
    let output = access.destination.appendingPathComponent(filename)
    let before = try NativeExportStorage.hash(output)
    let hasPublishedBytes =
      item.status == "prepared" && before == item.afterHash && item.stagingIdentity != nil
    let publishedIdentity = hasPublishedBytes ? try NativeExportStorage.identity(output) : nil
    let published = hasPublishedBytes && publishedIdentity == item.stagingIdentity
    try access.protect(output, originals: record.originals, provenOwnership: published)
    if item.status == "prepared" {
      try staging(item, record: record, access: access)
      guard item.output == output else {
        throw NativeExportError.message(
          "The saved destination changed. Review this export before resuming.")
      }
      if published {
        var applied = item
        if FileManager.default.fileExists(atPath: item.staging!.path) {
          try FileManager.default.removeItem(at: item.staging!)
        }
        try NativeExportStorage.syncDirectory(access.destination)
        applied.status = "applied"
        return applied
      }
      guard before == item.beforeHash, try NativeExportStorage.hash(item.staging!) == item.afterHash
      else {
        throw NativeExportError.message(
          "The prepared output changed or is missing. Retry this photo to render it again.")
      }
      return item
    }
    if item.status == "rendering" {
      try staging(item, record: record, access: access)
      guard item.output == output, before == item.beforeHash else {
        throw NativeExportError.message(
          "Output changed while the export was interrupted. Review it before retrying.")
      }
      guard !FileManager.default.fileExists(atPath: item.staging!.path) else {
        throw NativeExportError.message(
          "Interrupted staging has no completed byte proof. Its bytes were preserved; retry this photo with a new staging file."
        )
      }
    }
    let claimedBySibling = record.items.contains {
      $0.target.index != item.target.index && $0.output == output
        && ["rendering", "prepared", "applied"].contains($0.status)
    }
    guard !claimedBySibling else {
      throw NativeExportError.message(
        "Another photo in this export already uses \(filename). Add {n} to the naming template, then retry."
      )
    }
    if before != nil {
      if record.recipe.overwritePolicy == "skip" {
        var skipped = item
        skipped.status = "skipped"
        skipped.output = output
        return skipped
      }
      if record.recipe.overwritePolicy == "error" {
        throw NativeExportError.message(
          "Output already exists. Choose another name, Skip, or Replace.")
      }
    }
    var result = item
    result.status = "rendering"
    result.output = output
    result.staging = access.destination.appendingPathComponent(
      ".maple-export-\(record.id.uuidString)-\(UUID().uuidString).tmp")
    result.beforeHash = before
    result.afterHash = nil
    result.stagingIdentity = nil
    result.reason = nil
    try staging(result, record: record, access: access)
    guard !FileManager.default.fileExists(atPath: result.staging!.path) else {
      throw NativeExportError.message("Export staging already exists. Retry with a new export.")
    }
    return result
  }

  static func render(
    _ item: NativeExportItem, record: NativeExportRecord, access: NativeExportAccess
  ) throws -> NativeExportItem {
    try staging(item, record: record, access: access)
    guard let source = access.sources[item.id], let output = item.staging else {
      throw NativeExportError.message("The prepared export is incomplete.")
    }
    for (name, expected) in record.filmHashes {
      guard let film = record.filmDirectory,
        try NativeExportStorage.hash(film.appendingPathComponent(name)) == expected
      else {
        throw NativeExportError.message(
          "The captured film look changed or is missing. Start a new export.")
      }
    }
    guard !FileManager.default.fileExists(atPath: output.path) else {
      throw NativeExportError.message(
        "Staging already exists. Review it before retrying; existing bytes were preserved.")
    }
    try NativeExportRecipeBridge.render(
      source: source, xmp: item.target.xmp, recipe: record.recipe,
      filmDirectory: record.filmDirectory, staging: output)
    guard let hash = try NativeExportStorage.hash(output) else {
      throw NativeExportError.message("Encoder produced no staging file. Retry this photo.")
    }
    var prepared = item
    prepared.status = "prepared"
    prepared.afterHash = hash
    prepared.stagingIdentity = try NativeExportStorage.identity(output)
    return prepared
  }

  static func publish(
    _ item: NativeExportItem, record: NativeExportRecord, access: NativeExportAccess,
    cancellation: NativeExportCancellation
  ) throws -> NativeExportItem {
    try staging(item, record: record, access: access)
    guard try sourceMatches(item, access: access),
      let output = item.output, let temp = item.staging, let after = item.afterHash
    else {
      throw NativeExportError.message(
        "The original identity or bytes changed, or export is incomplete. Choose the unchanged original again, or start a new export."
      )
    }
    try access.protect(output, originals: record.originals)
    guard try NativeExportStorage.hash(output) == item.beforeHash else {
      throw NativeExportError.message(
        "Output changed before publication. Review it before retrying.")
    }
    guard try NativeExportStorage.hash(temp) == after else {
      throw NativeExportError.message(
        "Prepared output changed before publication. Retry this photo.")
    }
    let committed = try cancellation.publish {
      if record.recipe.overwritePolicy == "replace" { return Darwin.rename(temp.path, output.path) }
      return Darwin.link(temp.path, output.path)
    }
    var result = item
    if committed != 0 {
      if errno == EEXIST && record.recipe.overwritePolicy == "skip" {
        result.status = "skipped"
      } else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
    } else {
      result.status = "applied"
    }
    try? FileManager.default.removeItem(at: temp)
    do { try NativeExportStorage.syncDirectory(access.destination) } catch {
      throw NativeExportPublicationDurabilityError(detail: error.localizedDescription)
    }
    return result
  }

  static func discardStaging(
    _ item: NativeExportItem, record: NativeExportRecord, access: NativeExportAccess,
    createdThisRun: Bool
  ) throws {
    guard let temp = item.staging, FileManager.default.fileExists(atPath: temp.path) else { return }
    try staging(item, record: record, access: access)
    let proven =
      item.stagingIdentity != nil && item.afterHash != nil
      && (try NativeExportStorage.identity(temp)) == item.stagingIdentity
      && (try NativeExportStorage.hash(temp)) == item.afterHash
    guard proven || createdThisRun else { return }
    try FileManager.default.removeItem(at: temp)
  }

  private static func sourceMatches(_ item: NativeExportItem, access: NativeExportAccess) throws
    -> Bool
  {
    guard let source = access.sources[item.id],
      FileManager.default.fileExists(atPath: source.path)
    else { return false }
    let captured = item.target.source
    let expected = captured.authorizedIdentity ?? captured.identity
    guard try NativeExportStorage.identity(source) == expected else { return false }
    return try NativeExportStorage.hash(source) == captured.originalHash
      && NativeExportStorage.identity(source) == expected
  }

  static func staging(
    _ item: NativeExportItem, record: NativeExportRecord, access: NativeExportAccess
  ) throws {
    guard let temp = item.staging, temp.isFileURL, temp.standardizedFileURL == temp,
      temp.deletingLastPathComponent() == access.destination,
      temp.lastPathComponent.hasPrefix(".maple-export-\(record.id.uuidString)-"),
      temp.pathExtension == "tmp",
      UUID(
        uuidString: String(
          temp.lastPathComponent.dropFirst(".maple-export-\(record.id.uuidString)-".count).dropLast(
            4))) != nil
    else {
      throw NativeExportError.message(
        "Saved staging does not belong to this export and destination.")
    }
    if FileManager.default.fileExists(atPath: temp.path) {
      let values = try temp.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
      guard values.isRegularFile == true, values.isSymbolicLink != true else {
        throw NativeExportError.message("Staging must be a regular file, not a link or directory.")
      }
    }
    let exists = FileManager.default.fileExists(atPath: temp.path)
    let identity = exists ? try NativeExportStorage.identity(temp) : nil
    let hash = exists ? try NativeExportStorage.hash(temp) : nil
    let proven =
      exists && item.stagingIdentity != nil && identity == item.stagingIdentity
      && hash == item.afterHash
    try access.protect(temp, originals: record.originals, provenOwnership: proven)
    if exists && item.status == "prepared" {
      guard proven else {
        throw NativeExportError.message(
          "Prepared staging identity or bytes changed. Its contents were preserved for review.")
      }
    }

  }
}

struct NativeExportPublicationDurabilityError: LocalizedError {
  let detail: String
  var errorDescription: String? {
    "Output publication needs durability recovery: \(detail). Resume the saved export to verify the published bytes."
  }
}
