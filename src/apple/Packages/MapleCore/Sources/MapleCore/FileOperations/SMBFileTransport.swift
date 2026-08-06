// SMBFileTransport.swift — the narrow slice of `SMB2Manager` the SMB
// file-operations engine needs (issue #2631). `SMB2Manager` conforms via the
// plain extension below (every signature below is copied verbatim from
// AMSMB2's public API, so the conformance is a no-op).
//
// Why a protocol at all: there is no SMB server available in this
// environment to test against (`SMBSource.swift`'s own network calls have
// no integration tests today for the same reason), and "no mocks" in
// CLAUDE.md is specifically about the sidecar layer, not a general ban on
// testing seams. Substituting an in-memory fake here exercises the REAL
// relocate/collision/sidecar-follow ORCHESTRATION logic in
// `SMBFileOperations` end to end — the thing this module actually owns —
// without pretending to also validate AMSMB2's wire protocol, which isn't
// this module's job.

import Foundation
import AMSMB2

public protocol SMBFileTransport: Sendable {
    func attributesOfItem(atPath path: String) async throws -> [URLResourceKey: any Sendable]
    func contentsOfDirectory(atPath path: String, recursive: Bool) async throws -> [[URLResourceKey: Any]]
    func copyItem(atPath path: String, toPath: String, recursive: Bool,
                  progress: (@Sendable (Int64, Int64) -> Bool)?) async throws
    func removeItem(atPath path: String) async throws
    func createDirectory(atPath path: String) async throws
    func moveItem(atPath path: String, toPath: String) async throws
    func setAttributes(attributes: [URLResourceKey: Any], ofItemAtPath path: String) async throws
}

extension SMB2Manager: SMBFileTransport {}
