// PhoneSearchStub.swift — responsive-program S1a (#597) / S7 (#622).
//
// S7 wires the real `SearchView` into the phone Search tab. The file
// name stays `PhoneSearchStub.swift` so the existing Xcode group + git
// history follow the rename cleanly — once a follow-up PR renames the
// file the call sites won't move. Today the stub IS the production view.

#if os(iOS)

import SwiftUI
import MapleCore

struct PhoneSearchStub: View {
    var body: some View {
        SearchView()
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
