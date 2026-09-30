// ManageUsersView.swift
// Owner administration uses the server's passkey and step-up protected UI.

import MapleCore
import SwiftUI

struct ManageUsersView: View {
  let client: AuthClient

  var body: some View {
    Form {
      Section("Invite a user") {
        Text(
          "Create a single-use invite code in the server's Users settings, then copy and share it with the new member."
        )
        .foregroundStyle(.secondary)
        Link("Open user management", destination: client.server.appending(path: "/settings/users"))
      }
    }
  }
}

#Preview("Owner") {
  ManageUsersView(client: AuthClient.preview())
}
