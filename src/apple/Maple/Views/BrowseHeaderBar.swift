import MapleCore
import MapleUI
import SwiftUI

/// What the iPad Browse header shows and does (#5435). Built by `AppShell`,
/// which owns the sidebar visibility, search and Settings state.
struct BrowseHeaderModel {
  let title: String
  let displayMode: Binding<GridDisplayMode>
  let searchAvailable: Bool
  let isSidebarVisible: Bool
  let onOpenSearch: () -> Void
  let onSettings: () -> Void
  let onToggleSidebar: () -> Void
}

/// The iPad Browse header: the sidebar toggle, the folder name with the grid
/// filters, and the browse controls float on one row over the grid in the
/// photo header's glass, replacing the navigation bar and its title band.
struct BrowseHeaderBar<Filters: View>: View {
  let model: BrowseHeaderModel
  let vm: BrowseViewModel
  @ViewBuilder let filters: () -> Filters

  var body: some View {
    glassContainer
      .padding(.horizontal, 12)
      .padding(.top, 8)
      .padding(.bottom, 4)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("browse-header")
  }

  @ViewBuilder private var glassContainer: some View {
    if #available(iOS 26.0, macOS 26.0, *) {
      GlassEffectContainer(spacing: 12) { controls }
    } else {
      controls
    }
  }

  private var controls: some View {
    HStack(spacing: 12) {
      iconButton(
        icon: "side_navigation",
        label: model.isSidebarVisible ? "Hide sidebar" : "Show sidebar",
        id: "browse-sidebar-toggle", action: model.onToggleSidebar
      )
      .frame(width: 44, height: 44)
      .modifier(PhotoHeaderGlass())
      .fixedSize()

      HStack(spacing: 12) {
        Text(model.title)
          .font(.system(size: 16, weight: .medium))
          .lineLimit(1)
          .truncationMode(.middle)
          .layoutPriority(1)
          .accessibilityAddTraits(.isHeader)
          .accessibilityIdentifier("browse-title")
        filters()
      }
      .padding(.leading, 16)
      .padding(.trailing, 4)
      .frame(maxWidth: .infinity, alignment: .leading)
      .frame(height: 44)
      .modifier(PhotoHeaderGlass())

      HStack(spacing: 4) { trailingControls }
        .padding(.horizontal, 4)
        .frame(height: 44)
        .modifier(PhotoHeaderGlass())
        .fixedSize()
    }
    .foregroundStyle(ProTokens.text)
  }

  @ViewBuilder private var trailingControls: some View {
    let mode = model.displayMode
    iconButton(
      icon: mode.wrappedValue.toggleIconName,
      label: mode.wrappedValue.toggleAccessibilityLabel,
      id: "browse-grid-display-mode-toggle"
    ) { mode.wrappedValue = mode.wrappedValue.toggled }
    iconButton(
      icon: vm.isSelecting ? "check" : "check_box",
      label: vm.isSelecting
        ? "Exit selection mode" : "Enter multi-select mode to choose images for panorama merge",
      id: "multi-select-toggle"
    ) { vm.isSelecting ? vm.exitSelectMode() : vm.enterSelectMode() }
    if model.searchAvailable {
      iconButton(icon: "search", label: "Search", id: "search-toggle", action: model.onOpenSearch)
    }
    iconButton(icon: "settings", label: "Settings", id: "settings-button", action: model.onSettings)
  }

  private func iconButton(
    icon: String, label: String, id: String, action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      MuiIcon(name: icon, size: .sm)
        .foregroundStyle(MapleTokens.textMuted)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
    .accessibilityIdentifier(id)
  }
}
