// AuthUser.swift
//
// Split out of AuthSession.swift (2026-07-18, Maple TV milestone A,
// MapleCloudKit extraction) — `AuthUser` and `authLogger` are portable
// (no FileProvider dependency) and are needed by AddMapleCloudState,
// AddMapleCloudViewModel, AuthClient, and AuthUserCache, all of which live
// in this target. `AuthSession` itself stays in MapleCore/Auth/ because it
// calls `FileProviderDomainController`, which is not portable to tvOS.
// `authLogger` is `public` here (was file-internal `let` before the split)
// solely so AuthSession.swift, now in a different module, can keep using
// it — same Logger instance and behavior, just a wider access level to
// cross the new module boundary.
import OSLog

/// Logger for the auth subsystem. View in Xcode's debug console or
/// Console.app filtering on subsystem `app.justmaple.aperture.auth`.
/// Keep error-level events visible without being chatty.
public let authLogger = Logger(subsystem: "app.justmaple.aperture.auth", category: "session")

public struct AuthUser: Codable, Equatable, Sendable {
  public let id: String
  public let email: String
  public let role: String
  /// Per-user "file access" permission (#2899) — wire format from the API
  /// (`/api/auth/me` + login payloads). Absent on pre-upgrade servers; use
  /// `hasFileAccess`, which applies the granted-by-default rule.
  public let file_access: Bool?
  public var isOwner: Bool { role == "owner" }

  /// May this user browse the server filesystem / move files? Owners
  /// always can; members can unless the operator explicitly revoked it —
  /// mirroring the server's `userFileAccess` rule, so a pre-upgrade
  /// server (no field) never restricts anyone.
  public var hasFileAccess: Bool { isOwner || file_access != false }

  public init(id: String, email: String, role: String, file_access: Bool? = nil) {
    self.id = id
    self.email = email
    self.role = role
    self.file_access = file_access
  }
}
