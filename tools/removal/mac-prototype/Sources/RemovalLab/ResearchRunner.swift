import Foundation

struct Runtime: Decodable {
  let lamaPython: String
  let worker: String
  let sessions: String
}

struct Photo: Decodable {
  let raw: String
  let width: Int
  let height: Int
  let displayWidth: Int
  let displayHeight: Int
  let orientation: Int
  let preview: String
}

struct Candidate: Decodable, Identifiable {
  let id: String
  let label: String
  let folder: String
}

struct Experiment: Decodable {
  struct Failure: Decodable {
    let model: String
    let message: String
  }
  let candidates: [Candidate]
  let errors: [Failure]
  let complete: Bool
  let job: String
}

struct WorkerStatus: Decodable {
  let message: String
  let error: Bool?
}

struct Stroke: Codable {
  var points: [[Double]]
  let radius: Double
  let mode: String
}

/// One owned child; cancellation never targets other research/app processes.
final class ResearchProcess: @unchecked Sendable {
  static let shared = ResearchProcess()
  private let lock = NSLock()
  private var process: Process?

  func start(_ process: Process) throws {
    lock.lock()
    defer { lock.unlock() }
    guard self.process == nil else {
      throw NSError(
        domain: "RemovalLab", code: 1,
        userInfo: [
          NSLocalizedDescriptionKey: "A previous job is still stopping. Try again in a moment."
        ])
    }
    try process.run()
    self.process = process
  }

  func finished(_ process: Process) {
    lock.lock()
    defer { lock.unlock() }
    if self.process === process { self.process = nil }
  }

  func cancel() {
    lock.lock()
    defer { lock.unlock() }
    if let process, process.isRunning { process.terminate() }
  }
}

actor ResearchDisk {
  func load<T: Decodable>(_ type: T.Type, from url: URL) throws -> T {
    try JSONDecoder().decode(type, from: Data(contentsOf: url))
  }

  func data(_ path: String) throws -> Data { try Data(contentsOf: URL(fileURLWithPath: path)) }

  func create(root: String, request: [String: Any]) throws -> URL {
    let folder = URL(fileURLWithPath: root).appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try JSONSerialization.data(withJSONObject: request, options: [.prettyPrinted, .sortedKeys])
      .write(to: folder.appendingPathComponent("request.json"), options: .atomic)
    return folder
  }

  func preference(_ model: String, folder: URL) throws {
    let record: [String: Any] = [
      "preferredModel": model, "method": "guided-texture-transfer",
      "reviewedAt": ISO8601DateFormatter().string(from: Date()), "releaseQualified": false,
    ]
    try JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys])
      .write(to: folder.appendingPathComponent("review.json"), options: .atomic)
  }

  func run(command: String, folder: URL, runtime: Runtime, config: URL) async throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: runtime.lamaPython)
    process.arguments = [runtime.worker, command, folder.path, config.path]
    let logURL = folder.appendingPathComponent("launcher.log")
    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    let log = try FileHandle(forWritingTo: logURL)
    defer { try? log.close() }
    process.standardOutput = log
    process.standardError = log
    let code: Int32 = try await withCheckedThrowingContinuation { continuation in
      process.terminationHandler = { finished in
        ResearchProcess.shared.finished(finished)
        continuation.resume(returning: finished.terminationStatus)
      }
      do { try ResearchProcess.shared.start(process) } catch {
        continuation.resume(throwing: error)
      }
    }
    guard code == 0 else {
      let status = try? load(WorkerStatus.self, from: folder.appendingPathComponent("status.json"))
      throw NSError(
        domain: "RemovalLab", code: Int(code),
        userInfo: [
          NSLocalizedDescriptionKey: status?.message
            ?? "Research worker stopped. See the session logs."
        ])
    }
  }
}
