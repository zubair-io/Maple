// MaskListRow.swift — one row in the Mask panel's layer list (#3275).

import MapleCore
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
        }
    }

    private var name: String {
        switch layer.mask {
        case .bitmap: return "Skin"
        case .everywhere: return "Skin (whole image)"
        case .linear: return "Gradient"
        case .radial: return "Radial"
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: glyph).frame(width: 20)
            Text(name).font(.system(size: 13))
            Spacer()
            Toggle("", isOn: Binding(get: { isEnabled }, set: onToggleEnabled)).labelsHidden()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(isSelected ? MapleTokens.surfaceAlt : .clear)
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
        .swipeActions {
            Button(role: .destructive, action: onDelete) {
                Label("Delete", systemImage: "trash")
            }
        }
        .accessibilityIdentifier("editor-mask-row-\(layer.id.uuidString)")
    }
}
