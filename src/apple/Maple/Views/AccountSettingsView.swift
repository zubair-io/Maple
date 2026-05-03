// AccountSettingsView.swift
import SwiftUI
import MapleCore

struct AccountSettingsView: View {
  @Environment(AuthSession.self) private var session
  @State private var me: AuthMeResponse? = nil
  let client: AuthClient

  var body: some View {
    Form {
      if let user = session.user {
        Section("Account") {
          LabeledContent("Email", value: user.email)
          LabeledContent("Role", value: user.role.capitalized)
        }
      }
      if let creds = me?.credentials {
        Section("Passkeys") {
          ForEach(creds) { c in
            HStack {
              VStack(alignment: .leading) {
                Text(c.device_label)
                if let last = c.last_used_at { Text("Last used \(last)").font(.caption2).foregroundStyle(.secondary) }
              }
              Spacer()
              if creds.count > 1 {
                Button(role: .destructive) { Task { await remove(c.id) } } label: { Image(systemName: "trash") }
              }
            }
          }
        }
      }
      Section { Button("Sign out", role: .destructive) { Task { await session.signOut() } } }
    }
    .task { me = try? await client.me(accessToken: TokenStore.load(server: client.server)?.access ?? "") }
  }

  func remove(_ id: String) async {
    guard let access = try? TokenStore.load(server: client.server)?.access else { return }
    try? await client.deleteCredential(id: id, accessToken: access)
    me = try? await client.me(accessToken: access)
  }
}
