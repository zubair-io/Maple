import AMSMB2
import Foundation

@testable import MapleCore

/// Real authenticated transport. The owned fixture mutation occurs at the
/// actual publication call boundary; reads/copies/renames use the live SDK.
actor RestoreRealSMBTransport: SMBFileTransport {
  let client: SMB2Manager
  let mutation: @Sendable (String, String) throws -> Void
  let removalMutation: (@Sendable (String) throws -> Void)?
  private var removed = false
  private var intercepted = false

  init(
    client: SMB2Manager, removalMutation: (@Sendable (String) throws -> Void)? = nil,
    mutation: @escaping @Sendable (String, String) throws -> Void = { _, _ in }
  ) {
    self.client = client
    self.mutation = mutation
    self.removalMutation = removalMutation
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
    if !removed && path.contains("/.maple/trash/") && path.hasSuffix(".dng") {
      removed = true
      try removalMutation?(path)
    }
    try await client.removeItem(atPath: path)
  }
  func removeRestoreFile(
    atPath path: String, expectedIdentity: UInt64,
    validate: @Sendable @escaping (Data) -> Bool
  ) async throws {
    if !removed && path.contains("/.maple/trash/") && path.hasSuffix(".dng") {
      removed = true
      try removalMutation?(path)
    }
    try await client.removeRestoreFile(
      atPath: path, expectedIdentity: expectedIdentity, validate: validate)
  }
  func moveRestoreFile(
    atPath path: String, toPath: String, expectedIdentity: UInt64,
    validate: @Sendable @escaping (Data) -> Bool
  ) async throws {
    if !intercepted && path.contains(".tmp.") && toPath.lowercased().hasSuffix(".dng") {
      intercepted = true
      try mutation(path, toPath)
    }
    try await client.moveRestoreFile(
      atPath: path, toPath: toPath, expectedIdentity: expectedIdentity, validate: validate)
  }
  func createDirectory(atPath path: String) async throws {
    try await client.createDirectory(atPath: path)
  }
  func moveItem(atPath path: String, toPath: String) async throws {
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
