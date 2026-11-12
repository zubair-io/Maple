// MaskListRow.swift — one row in the Mask panel's layer list (#3275).

import MapleCore
import MapleUI
import SwiftUI

struct MaskListRow: View {
  let layer: LocalAdjustment
  let isSelected: Bool
  let isEnabled: Bool
  let onSelect: () -> Void
  let onToggleEnabled: (Bool) -> Void
  let onDelete: () -> Void

  private var glyph: String {
    switch layer.mask {
    case .linear: return "line.diagonal"
    case .radial: return "circle.dashed"
    case .bitmap, .everywhere: return "person.crop.rectangle"
    case .brush: return "paintbrush"
    case .group: return "square.stack"
    }
  }

  private var name: String {
    switch layer.mask {
    case .bitmap: return "Skin"
    case .everywhere: return "Skin (whole image)"
    case .linear: return "Gradient"
    case .radial: return "Radial"
    case .brush: return "Brush"
    case .group: return "Mask group"
    }
  }

  var body: some View {
    HStack(spacing: 10) {
      Button(action: onSelect) {
        HStack(spacing: 10) {
          MuiIcon(name: glyph, size: .sm).frame(width: 20)
          Text(name).font(.system(size: 13))
          Spacer()
        }
        .frame(minHeight: 32)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(name) mask")
      .accessibilityAddTraits(isSelected ? .isSelected : [])
      .accessibilityIdentifier("editor-mask-select-\(layer.id.uuidString)")
      Toggle("", isOn: Binding(get: { isEnabled }, set: onToggleEnabled)).labelsHidden()
        .accessibilityLabel("Show \(name) mask")
        .accessibilityIdentifier("editor-mask-visible-\(layer.id.uuidString)")
      // Swipe-to-delete needs a touch screen or a trackpad; the button
      // is the same action for a mouse and for anyone who looks for it.
      Button(role: .destructive, action: onDelete) {
        MuiIcon(name: "delete", size: .sm)
          .foregroundStyle(MapleTokens.textMuted)
          .frame(width: 32, height: 32)
          .contentShape(Rectangle())
      }
      .buttonStyle(.borderless)
      .accessibilityLabel("Delete \(name) mask")
      .accessibilityIdentifier("editor-mask-delete-\(layer.id.uuidString)")
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 4)
    .background(isSelected ? MapleTokens.surfaceAlt : .clear)
    .swipeActions {
      Button(role: .destructive, action: onDelete) {
        Label("Delete", systemImage: "trash")
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-mask-row-\(layer.id.uuidString)")
  }
}
