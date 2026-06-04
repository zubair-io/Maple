// Sources/MapleBackup/AuthorizingTransport.swift
import Foundation

/// An async HTTP transport that performs an *authenticated* round-trip.
///
/// `MapleBackup` is a leaf package and can't see `MapleCore`'s
/// `AuthenticatedHTTPClient`, so the backup clients depend on this closure
/// instead. In the app it is wired to `AuthenticatedHTTPClient.data(for:)`,
/// which injects the `Bearer` access token and performs single-flight
/// 401-refresh-retry; tests pass a stub.
///
/// It is a required initializer parameter on the backup clients (no default)
/// on purpose — a missing transport is a compile error, so no construction
/// site can silently send backup traffic unauthenticated (#855).
public typealias AuthorizingTransport = @Sendable (URLRequest) async throws -> (Data, URLResponse)
