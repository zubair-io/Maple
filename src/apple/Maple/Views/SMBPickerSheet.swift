// SMBPickerSheet.swift — Modal sheet that collects SMB connection
// credentials (host, share, username, password) and surfaces them via
// callbacks. Extracted from AppShell.swift as part of the multi-PR
// AppShell split (#123, slice 1).

import SwiftUI
import MapleCore

// MARK: - SMB sheet

struct SMBPickerSheet: View {
    let onConnect: (SMBSource.Credentials) -> Void
    let onCancel: () -> Void

    @State private var host = ""
    @State private var share = ""
    @State private var username = ""
    @State private var password = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connect to SMB Share")
                .font(.title3).bold()
            Form {
                TextField("Host (e.g. nas.local)", text: $host)
                TextField("Share name",           text: $share)
                TextField("Username",             text: $username)
                SecureField("Password",           text: $password)
            }
            HStack {
                Spacer()
                Button("Cancel", action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button("Connect") {
                    onConnect(SMBSource.Credentials(
                        host: host, share: share,
                        username: username, password: password
                    ))
                }
                .keyboardShortcut(.defaultAction)
                .disabled(host.isEmpty || share.isEmpty)
            }
        }
        .padding(20)
        .frame(minWidth: 380)
    }
}
