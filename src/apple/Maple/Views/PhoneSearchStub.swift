// PhoneSearchStub.swift — placeholder for the Search tab on the
// phone-tier shell (responsive-program S1a, #597).
//
// S7 will replace the body with real search results (cloud + on-device
// face/object index). For now we render the Search header chrome (a
// disabled search-field stub) so the tab is visibly correct end-to-end
// and so the placement-of-elements is on-spec before content lands.

#if os(iOS)

import SwiftUI
import MapleCore

struct PhoneSearchStub: View {
    @State private var query: String = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Search", text: $query)
                    .textFieldStyle(.plain)
                    .disabled(true)
                    .accessibilityLabel("Search photos")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(MapleTokens.surface)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .padding(.horizontal, 12)
            .padding(.top, 8)

            Spacer(minLength: 24)

            Text("Search — coming in S7")
                .font(.callout)
                .foregroundStyle(.secondary)

            Spacer()
        }
        .navigationTitle("Search")
        .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview {
    NavigationStack {
        PhoneSearchStub()
    }
}

#endif
