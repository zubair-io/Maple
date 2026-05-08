// InviteQR.swift
//
// Plan 2026-04-28-passkey-auth Task B10.
//
// Encodes / decodes the QR-payload contract for Self-Hosted onboarding:
//
//   maple://join?server=<base64url URL>&code=<8-char base32>&email=<base64url email>
//
// The server-URL and email are base64url-encoded so the QR text is URL-safe
// regardless of the host's characters (ports, query strings, "+"-laden
// addresses). The invite code is RFC 4648 base32 (no 0/1/8/9) — already
// QR-safe — and is round-tripped verbatim against the server.
//
// `parseInviteQR` is the load-bearing piece: any code path that reads a
// scanned/pasted string from the user is expected to feed it through this
// helper before deciding whether to present `AddMapleCloudSheet` pre-filled.
//
// `buildInvitePayload` is its inverse and is used by `ManageUsersView` to
// emit a QR alongside a freshly-minted invite code.

import Foundation

/// A successfully parsed `maple://join?…` QR payload.
struct InviteQR: Equatable {
  let server: URL
  let code: String
  let email: String
}

// MARK: - base64url helpers (app-target local copy)
//
// `MapleCore` keeps its `Data(base64URLEncoded:)` / `base64URLEncodedString()`
// helpers `internal`, so the app target can't reach them through `import
// MapleCore`. Duplicate them here as `fileprivate` so the parser stays
// self-contained — same byte-for-byte behaviour as the MapleCore copy
// (RFC 4648 base64url, padding optional on input, stripped on output).

extension Data {
  fileprivate init?(invite_base64URLEncoded s: String) {
    var t = s.replacingOccurrences(of: "-", with: "+")
             .replacingOccurrences(of: "_", with: "/")
    while t.count % 4 != 0 { t.append("=") }
    self.init(base64Encoded: t)
  }

  fileprivate func invite_base64URLEncodedString() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

/// Parses a scanned QR string into an `InviteQR`. Returns `nil` for any
/// payload that isn't shaped exactly like the contract above — including
/// missing fields, malformed base64url, or non-`maple://join` URLs.
///
/// The plan spec uses `URL.host == "join"` as the discriminator. URL
/// parsing of `maple://join?...` puts `join` in the host, not the path,
/// because there's no `/` between the scheme and the query.
func parseInviteQR(_ raw: String) -> InviteQR? {
  guard let url = URL(string: raw),
        url.scheme == "maple",
        url.host == "join",
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
  else { return nil }

  // Build a name -> value map. `uniqueKeysWithValues` is fine here — duplicate
  // query keys in an invite payload are a malformed input we should reject; if
  // a future caller wants tolerance it can switch to `merging(_:uniquingKeysWith:)`.
  let m = Dictionary(uniqueKeysWithValues: comps.compactMap { ($0.name, $0.value ?? "") })

  guard let serverEnc = m["server"],
        let code = m["code"],
        let emailEnc = m["email"],
        let serverData = Data(invite_base64URLEncoded: serverEnc),
        let serverStr = String(data: serverData, encoding: .utf8),
        let server = URL(string: serverStr),
        let emailData = Data(invite_base64URLEncoded: emailEnc),
        let email = String(data: emailData, encoding: .utf8)
  else { return nil }

  return InviteQR(server: server, code: code, email: email)
}

/// Builds the `maple://join?…` payload string for a fresh invite. Inverse of
/// `parseInviteQR` — `parseInviteQR(buildInvitePayload(server:code:email:))`
/// must round-trip.
func buildInvitePayload(server: URL, code: String, email: String) -> String {
  let serverEnc = Data(server.absoluteString.utf8).invite_base64URLEncodedString()
  let emailEnc = Data(email.utf8).invite_base64URLEncodedString()
  return "maple://join?server=\(serverEnc)&code=\(code)&email=\(emailEnc)"
}
