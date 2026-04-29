// ManageUsersView.swift
import SwiftUI
import MapleCore

struct ManageUsersView: View {
  @Environment(AuthSession.self) private var session
  @State private var inviteEmail = ""
  @State private var newCode: String? = nil
  @State private var pending: [(code: String, email: String, expiresAt: String, consumedAt: String?)] = []
  let client: AuthClient

  var body: some View {
    Form {
      Section("Invite a user") {
        TextField("Email", text: $inviteEmail)
        Button("Generate invite code") { Task { await invite() } }
          .disabled(inviteEmail.isEmpty)
        if let code = newCode {
          Text("Share: **\(code)**").textSelection(.enabled)
        }
      }
      Section("Pending invites") {
        ForEach(pending, id: \.code) { p in
          HStack {
            VStack(alignment: .leading) { Text(p.email); Text(p.code).font(.caption.monospaced()) }
            Spacer()
            Button("Rescind", role: .destructive) { Task { await rescind(p.code) } }
          }
        }
      }
    }
    .task { await reload() }
  }

  func invite() async {
    guard let access = try? TokenStore.load(server: client.server)?.access else { return }
    let r = try? await client.createInvite(email: inviteEmail, accessToken: access)
    newCode = r?.code; await reload()
  }
  func rescind(_ code: String) async {
    guard let access = try? TokenStore.load(server: client.server)?.access else { return }
    try? await client.rescindInvite(code: code, accessToken: access); await reload()
  }
  func reload() async {
    guard let access = try? TokenStore.load(server: client.server)?.access else { return }
    let raw = (try? await client.listInvites(accessToken: access)) ?? []
    pending = raw.compactMap {
      guard let code = $0["code"] as? String, let email = $0["email"] as? String,
            let exp = $0["expires_at"] as? String else { return nil }
      return (code, email, exp, $0["consumed_at"] as? String)
    }
  }
}
