import Foundation

public struct BatchAdjustmentTarget: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let name: String
  public let url: URL?
  public let hintExtension: String?
  public let isRaw: Bool?

  public init(id: String, name: String, url: URL?, hintExtension: String? = nil, isRaw: Bool? = nil)
  {
    self.id = id
    self.name = name
    self.url = url
    self.hintExtension = hintExtension
    self.isRaw = isRaw
  }
}

public struct BatchAdjustmentRequest: Codable, Sendable {
  public let source: AdjustmentModel
  public let groupIDs: [String]
  public let relativeWhiteBalance: Bool
  public let sourceBaseline: WhiteBalanceTransferBaseline?

  public init(
    source: AdjustmentModel, groups: Set<AdjustmentGroup>, relativeWhiteBalance: Bool,
    sourceBaseline: WhiteBalanceTransferBaseline?
  ) {
    self.source = source
    self.groupIDs = groups.map(\.rawValue).sorted()
    self.relativeWhiteBalance = relativeWhiteBalance
    self.sourceBaseline = sourceBaseline
  }

  public var groups: Set<AdjustmentGroup> {
    Set(groupIDs.compactMap(AdjustmentGroup.init(rawValue:)))
  }
}

public struct BatchAdjustmentOperation: Codable, Sendable, Identifiable {
  public let id: UUID
  public let scopeID: String
  public let createdAt: Date
  public let request: BatchAdjustmentRequest
  public let targets: [BatchAdjustmentTarget]
  public var status: BatchTransferStatus
  public var dismissedAt: Date?
  /// Exact target set of an interrupted attempt, including failed-only retries.
  public var attemptTargetIDs: [String]?
  public var attemptID: UUID?
}

public struct BatchAdjustmentSnapshot: Sendable {
  public let operation: BatchAdjustmentOperation
  public let summary: BatchTransferSummary
  public let pendingCount: Int
}

public enum BatchAdjustmentError: Error, LocalizedError {
  case operationRunning, wrongLibrary, invalidOperation, sharedSidecar

  public var errorDescription: String? {
    switch self {
    case .operationRunning: return "Another settings transfer is already running. Cancel it first."
    case .wrongLibrary: return "Open the original library to resume this settings transfer."
    case .invalidOperation: return "This saved transfer is invalid or from an unsupported version."
    case .sharedSidecar:
      return
        "Some selected photos share one XMP sidecar. Select only one photo with each filename stem."
    }
  }
}

/// One durable per-asset ledger. Each patch is written before its sidecar, and
/// each success follows confirmed I/O. A crash between those writes replays the
/// same absolute patch. One file per outcome keeps 2,000 targets linear in I/O.
public actor BatchAdjustmentTransfer {
  /// App windows share this actor so the same durable ledger cannot run twice.
  public static let shared = BatchAdjustmentTransfer(
    directory: URL.applicationSupportDirectory.appendingPathComponent("Maple/AdjustmentTransfers"))
  public typealias Prepare =
    @Sendable (BatchAdjustmentTarget, BatchAdjustmentRequest) async throws ->
    PreparedAdjustmentTransfer
  public typealias Apply =
    @Sendable (BatchAdjustmentTarget, PreparedAdjustmentTransfer) async throws -> Void
  public typealias Progress = @Sendable (BatchTransferProgress) async -> Void

  private struct AssetRecord: Codable {
    var status: BatchAssetStatus
    var patch: PreparedAdjustmentTransfer?
    var error: String?
    var attemptID: UUID?
  }

  private let directory: URL
  private var runningID: UUID?
  private var cancelledIDs: Set<UUID> = []
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  public init(directory: URL) { self.directory = directory }

  public func create(
    scopeID: String, request: BatchAdjustmentRequest, targets: [BatchAdjustmentTarget]
  ) throws -> BatchAdjustmentOperation {
    guard runningID == nil else { throw BatchAdjustmentError.operationRunning }
    guard !scopeID.isEmpty, !request.groups.isEmpty,
      request.groups.count == request.groupIDs.count,
      !targets.isEmpty, targets.allSatisfy({ !$0.id.isEmpty }),
      Set(targets.map(\.id)).count == targets.count
    else { throw BatchAdjustmentError.invalidOperation }
    guard Self.uniqueDestinations(targets) else { throw BatchAdjustmentError.sharedSidecar }
    let operation = BatchAdjustmentOperation(
      id: UUID(), scopeID: scopeID, createdAt: Date(), request: request,
      targets: targets, status: .ready)
    try FileManager.default.createDirectory(
      at: operationDirectory(operation.id), withIntermediateDirectories: true)
    try write(operation, to: manifestURL(operation.id))
    return operation
  }

  public func operations(in scopeID: String) throws -> [BatchAdjustmentSnapshot] {
    guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
    let children = try FileManager.default.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: nil)
    let operations = try children.compactMap { child -> BatchAdjustmentOperation? in
      guard let id = UUID(uuidString: child.lastPathComponent) else { return nil }
      let operation = try load(id)
      return operation.scopeID == scopeID && operation.dismissedAt == nil ? operation : nil
    }
    return try operations.sorted { $0.createdAt > $1.createdAt }.map(snapshot)
  }

  public func latest(in scopeID: String) throws -> BatchAdjustmentSnapshot? {
    try operations(in: scopeID).first
  }

  public func dismiss(_ id: UUID) throws {
    guard runningID != id else { throw BatchAdjustmentError.operationRunning }
    var operation = try load(id)
    operation.dismissedAt = Date()
    try write(operation, to: manifestURL(id))
  }

  public func cancel(_ id: UUID) throws {
    cancelledIDs.insert(id)
    var operation = try load(id)
    operation.status = .cancelled
    try write(operation, to: manifestURL(id))
  }

  public func run(
    _ id: UUID, scopeID: String, retryFailed: Bool = false,
    prepare: Prepare, apply: Apply, progress: Progress
  ) async throws -> BatchAdjustmentSnapshot {
    guard runningID == nil else { throw BatchAdjustmentError.operationRunning }
    var operation = try load(id)
    guard operation.scopeID == scopeID else { throw BatchAdjustmentError.wrongLibrary }
    runningID = id
    defer { runningID = nil }
    cancelledIDs.remove(id)
    if retryFailed || operation.attemptTargetIDs == nil {
      operation.attemptID = UUID()
      operation.attemptTargetIDs = try operation.targets.enumerated().compactMap { index, target in
        let status = try readRecord(id, index: index)?.status ?? .pending
        let included = retryFailed ? status == .failed : (status == .pending || status == .prepared)
        return included ? target.id : nil
      }
    }
    let attemptIDs = Set(operation.attemptTargetIDs ?? [])
    operation.status = .running
    try write(operation, to: manifestURL(id))
    let initial = try snapshot(operation)
    var appliedCount = initial.summary.applied.count
    var failedCount = initial.summary.failed.count

    for (index, target) in operation.targets.enumerated() {
      if cancelledIDs.contains(id) { break }
      let previous = try readRecord(id, index: index)
      if previous?.status == .applied { continue }
      guard attemptIDs.contains(target.id) else { continue }
      if previous?.status == .failed && previous?.attemptID == operation.attemptID { continue }
      var patch = previous?.patch
      let record: AssetRecord
      do {
        if patch == nil { patch = try await prepare(target, operation.request) }
        guard let prepared = patch else { throw BatchAdjustmentError.invalidOperation }
        try write(
          AssetRecord(
            status: .prepared, patch: prepared, error: nil, attemptID: operation.attemptID),
          to: recordURL(id, index: index))
        if cancelledIDs.contains(id) { break }
        try await apply(target, prepared)
        record = AssetRecord(
          status: .applied, patch: prepared, error: nil, attemptID: operation.attemptID)
      } catch {
        record = AssetRecord(
          status: .failed, patch: patch, error: error.localizedDescription,
          attemptID: operation.attemptID)
      }
      // A ledger write error must stop the operation. Reporting this as an
      // asset failure would misrepresent a sidecar that may already be saved.
      try write(record, to: recordURL(id, index: index))
      if previous?.status == .failed { failedCount -= 1 }
      if record.status == .applied { appliedCount += 1 } else { failedCount += 1 }
      await progress(
        BatchTransferProgress(
          total: operation.targets.count,
          processed: appliedCount + failedCount,
          applied: appliedCount, failed: failedCount,
          current: target.id, outcome: record.status))
    }
    let pendingCount = operation.targets.count - appliedCount - failedCount
    if !cancelledIDs.contains(id) {
      operation.attemptTargetIDs = nil
      operation.attemptID = nil
    }
    operation.status =
      cancelledIDs.contains(id) ? .cancelled : (pendingCount > 0 ? .ready : .complete)
    try write(operation, to: manifestURL(id))
    return try snapshot(operation)
  }

  private func snapshot(_ saved: BatchAdjustmentOperation) throws -> BatchAdjustmentSnapshot {
    var operation = saved
    if operation.status == .running && runningID != operation.id { operation.status = .ready }
    var applied: [String] = []
    var failures: [BatchTransferFailure] = []
    var pending = 0
    for (index, target) in operation.targets.enumerated() {
      switch try readRecord(operation.id, index: index) {
      case let record? where record.status == .applied:
        applied.append(target.id)
      case let record? where record.status == .failed:
        failures.append(.init(id: target.id, reason: record.error ?? "The write failed."))
      default: pending += 1
      }
    }
    return BatchAdjustmentSnapshot(
      operation: operation,
      summary: .init(applied: applied, failed: failures, cancelled: operation.status == .cancelled),
      pendingCount: pending)
  }

  private func load(_ id: UUID) throws -> BatchAdjustmentOperation {
    let operation = try decoder.decode(
      BatchAdjustmentOperation.self, from: Data(contentsOf: manifestURL(id)))
    guard operation.id == id, !operation.request.groups.isEmpty,
      operation.request.groups.count == operation.request.groupIDs.count,
      !operation.scopeID.isEmpty, !operation.targets.isEmpty,
      operation.targets.allSatisfy({ !$0.id.isEmpty }),
      Set(operation.targets.map(\.id)).count == operation.targets.count,
      Self.uniqueDestinations(operation.targets)
    else { throw BatchAdjustmentError.invalidOperation }
    if let attempt = operation.attemptTargetIDs {
      guard operation.attemptID != nil, Set(attempt).count == attempt.count,
        Set(attempt).isSubset(of: Set(operation.targets.map(\.id)))
      else { throw BatchAdjustmentError.invalidOperation }
    }
    return operation
  }

  private static func uniqueDestinations(_ targets: [BatchAdjustmentTarget]) -> Bool {
    let destinations = targets.map { target in
      let original =
        target.url
        ?? (target.id.hasPrefix("fs:")
          ? URL(fileURLWithPath: String(target.id.dropFirst(3))) : nil)
      return original.map { SidecarPath.sidecarURL(for: $0).standardizedFileURL.absoluteString }
        ?? target.id
    }
    return Set(destinations).count == targets.count
  }

  private func readRecord(_ id: UUID, index: Int) throws -> AssetRecord? {
    let url = recordURL(id, index: index)
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    return try decoder.decode(AssetRecord.self, from: Data(contentsOf: url))
  }

  private func write<T: Encodable>(_ value: T, to url: URL) throws {
    try encoder.encode(value).write(to: url, options: .atomic)
  }

  private func operationDirectory(_ id: UUID) -> URL {
    directory.appendingPathComponent(id.uuidString, isDirectory: true)
  }
  private func manifestURL(_ id: UUID) -> URL {
    operationDirectory(id).appendingPathComponent("operation.json")
  }
  private func recordURL(_ id: UUID, index: Int) -> URL {
    operationDirectory(id).appendingPathComponent("asset-\(index).json")
  }
}
