// #4152 — follow the selected row's actual layout, including lazy child
// listings and ancestor expansion. Scroll the row, not its whole subtree.
import SwiftUI

struct SidebarFolderReveal: Equatable {
  let id: String
  let frame: CGRect
}

struct SidebarFolderRevealPreference: PreferenceKey {
  static let defaultValue: SidebarFolderReveal? = nil

  static func reduce(value: inout SidebarFolderReveal?, nextValue: () -> SidebarFolderReveal?) {
    if let next = nextValue() { value = next }
  }
}

extension View {
  func sidebarFolderReveal(id: String, selected: Bool) -> some View {
    #if os(macOS)
      self.id(id)
        .background {
          GeometryReader { geometry in
            Color.clear.preference(
              key: SidebarFolderRevealPreference.self,
              value: selected
                ? SidebarFolderReveal(
                  id: id,
                  frame: geometry.frame(in: .named("sidebarFolderScroll")))
                : nil
            )
          }
        }
    #else
      self
    #endif
  }
}
