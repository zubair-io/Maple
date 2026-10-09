import AMSMB2
import Foundation

@testable import MapleCore

/// Real authenticated transport. The owned fixture mutation occurs at the
/// actual publication call boundary, and `markMutation` where the copy-only
/// restore marks the trashed pair restored; reads/copies/renames use the live
/// SDK. Every delete or rename whose source is a trashed file is recorded.
actor RestoreRealSMBTransport: SMBFileTransport {
  let client: SMB2Manager
  let mutation: @Sendable (String, String) throws -> Void
  let markMutation: (@Sendable (String) throws -> Void)?
  private(set) var trashedSourcesTouched: [String] = []
  private var marked = false
  private var intercepted = false

  init(
    client: SMB2Manager, markMutation: (@Sendable (String) throws -> Void)? = nil,
    mutation: @escaping @Sendable (String, String) throws -> Void = { _, _ in }
  ) {
    self.client = client
    self.mutation = mutation
    self.markMutation = markMutation
  }

  private func record(_ path: String) {
    if path.contains("/.maple/trash/") { trashedSourcesTouched.append(path) }
  }
  func attributesOfItem(atPath path: String) async throws -> [URLResourceKey: any Sendable] {
    try await client.attributesOfItem(atPath: path)
  }
  func contentsOfDirectory(atPath path: String, recursive: Bool) async throws -> [[URLResourceKey:
    Any]]
  {
    try await client.contentsOfDirectory(atPath: path, recursive: recursive)
  }
  func copyItem(
    atPath path: String, toPath: String, recursive: Bool,
    progress: (@Sendable (Int64, Int64) -> Bool)?
  ) async throws {
    try await client.copyItem(
      atPath: path, toPath: toPath, recursive: recursive, progress: progress)
  }
  func removeItem(atPath path: String) async throws {
    record(path)
    try await client.removeItem(atPath: path)
  }
  func readRestoreFile(
    atPath path: String, expectedIdentity: UInt64,
    consume: @Sendable @escaping (Data) -> Void
  ) async throws {
    try await client.readRestoreFile(
      atPath: path, expectedIdentity: expectedIdentity, consume: consume)
  }
  func moveRestoreFile(
    atPath path: String, toPath: String, expectedIdentity: UInt64,
    consume: @Sendable @escaping (Data) -> Void,
    validate: @Sendable @escaping (UInt64) -> Bool
  ) async throws {
    record(path)
    if !intercepted && path.contains(".tmp.") && toPath.lowercased().hasSuffix(".dng") {
      intercepted = true
      try mutation(path, toPath)
    }
    try await client.moveRestoreFile(
      atPath: path, toPath: toPath, expectedIdentity: expectedIdentity, consume: consume,
      validate: validate)
  }
  func createDirectory(atPath path: String) async throws {
    if !marked, path.contains("/.maple/trash/"),
      let marker = path.range(of: ".restored-", options: .backwards),
      path[..<marker.lowerBound].hasSuffix(".dng")
    {
      marked = true
      try markMutation?(String(path[..<marker.lowerBound]))
    }
    try await client.createDirectory(atPath: path)
  }
  func moveItem(atPath path: String, toPath: String) async throws {
    record(path)
    if !intercepted && path.contains(".tmp.") && toPath.hasSuffix(".dng") {
      intercepted = true
      try mutation(path, toPath)
    }
    try await client.moveItem(atPath: path, toPath: toPath)
  }
  func setAttributes(attributes: [URLResourceKey: Any], ofItemAtPath path: String) async throws {
    try await client.setAttributes(attributes: attributes, ofItemAtPath: path)
  }
  func readFile(atPath path: String) async throws -> Data {
    try await client.readFile(atPath: path)
  }
  func writeFile(data: Data, toPath path: String) async throws {
    try await client.writeFile(data: data, toPath: path)
  }
}
