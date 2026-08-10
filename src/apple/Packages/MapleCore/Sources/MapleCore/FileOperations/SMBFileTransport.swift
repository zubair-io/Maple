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
    /// Whole-file read, added for the on-share `.maple/thumbs/` cache
    /// (#2690): `SMBThumbCache` reads/writes through this same protocol so
    /// its tests substitute `FakeSMBTransport` instead of requiring a live
    /// SMB server, mirroring the relocate engine's existing seam. Named
    /// distinctly from AMSMB2's own overloaded `contents(atPath:range:)` —
    /// that method is generic over `RangeExpression` with a defaulted
    /// `progress` parameter, which doesn't structurally satisfy a
    /// non-generic protocol requirement of the same name, so the `SM2Manager`
    /// conformance below wraps it explicitly instead of matching for free.
    func readFile(atPath path: String) async throws -> Data
    /// Whole-file write — same naming rationale as `readFile` above; wraps
    /// AMSMB2's `write(data:toPath:progress:)`.
    func writeFile(data: Data, toPath path: String) async throws
}

extension SMB2Manager: SMBFileTransport {
    public func readFile(atPath path: String) async throws -> Data {
        try await contents(atPath: path, range: Range<UInt64>?.none)
    }

    public func writeFile(data: Data, toPath path: String) async throws {
        try await write(data: data, toPath: path, progress: nil)
    }
}
