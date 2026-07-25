// AdjustmentGroupPickerSheet.swift — selective-paste sheet (#944).
//
// Presented from PanoSelectionBar's "Paste Selected Groups…" button. Lets
// the user toggle which AdjustmentGroups move from the clipboard onto the
// checked selection, instead of the default "paste everything" behavior of
// the plain "Paste Adjustments" button.

import SwiftUI
import MapleCore

struct AdjustmentGroupPickerSheet: View {
    /// Display name of the asset the clipboard's adjustments were copied
    /// from — surfaced as "From IMG_0012" so the user knows what they're
    /// about to paste.
    let sourceName: String
    /// How many checked assets this paste will write to.
    let targetCount: Int
    let onApply: (Set<AdjustmentGroup>) -> Void
    let onCancel: () -> Void

    @State private var selectedGroups: Set<AdjustmentGroup> = Set(AdjustmentGroup.allCases)

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(AdjustmentGroup.allCases, id: \.self) { group in
                        Toggle(group.label, isOn: binding(for: group))
                            .accessibilityLabel("\(group.label) group")
                            .accessibilityIdentifier("paste-group-toggle-\(group.rawValue)")
                    }
                } header: {
                    Text("From \(sourceName)")
                }
            }
            .navigationTitle(navigationTitle)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onCancel() }
                        .accessibilityIdentifier("paste-group-picker-cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Paste") { onApply(selectedGroups) }
                        .disabled(selectedGroups.isEmpty)
                        .accessibilityLabel("Paste selected adjustment groups")
                        .accessibilityIdentifier("paste-group-picker-apply")
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 340, minHeight: 380)
        #endif
    }

    private var navigationTitle: String {
        targetCount == 1
            ? "Paste Adjustments (1 photo)"
            : "Paste Adjustments (\(targetCount) photos)"
    }

    private func binding(for group: AdjustmentGroup) -> Binding<Bool> {
        Binding(
            get: { selectedGroups.contains(group) },
            set: { isOn in
                if isOn {
                    selectedGroups.insert(group)
                } else {
                    selectedGroups.remove(group)
                }
            }
        )
    }
}

// MARK: - Previews

#Preview {
    AdjustmentGroupPickerSheet(
        sourceName: "IMG_0012",
        targetCount: 5,
        onApply: { _ in },
        onCancel: {}
    )
}
