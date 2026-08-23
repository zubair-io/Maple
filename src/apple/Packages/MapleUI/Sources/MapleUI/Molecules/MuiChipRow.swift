// MuiChipRow.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.2). Row of pills — select, apply, or edit — built from Badge, Icon,
// Input.

import SwiftUI

public struct MuiChip: Identifiable, Hashable, Sendable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

public enum MuiChipRowMode: Sendable {
    /// Single-select pills — tap to select, no remove affordance.
    case select
    /// Each pill carries its own remove ("×") affordance; nothing is
    /// selected.
    case removable
    /// Removable pills plus a trailing input for adding new ones.
    case editable
}

public struct MuiChipRow: View {
    public let chips: [MuiChip]
    public let mode: MuiChipRowMode
    @Binding public var selectedId: String?
    public let addPlaceholder: String
    public let removed: ((String) -> Void)?
    public let added: ((String) -> Void)?

    @State private var draft = ""

    public init(
        chips: [MuiChip],
        mode: MuiChipRowMode = .select,
        selectedId: Binding<String?> = .constant(nil),
        addPlaceholder: String = "Add…",
        removed: ((String) -> Void)? = nil,
        added: ((String) -> Void)? = nil
    ) {
        self.chips = chips
        self.mode = mode
        self._selectedId = selectedId
        self.addPlaceholder = addPlaceholder
        self.removed = removed
        self.added = added
    }

    public var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: MuiTokens.spacingXs) {
                ForEach(chips) { chip in
                    switch mode {
                    case .select:
                        selectChip(chip)
                    case .removable, .editable:
                        removableChip(chip)
                    }
                }

                if mode == .editable {
                    MuiInput(
                        value: $draft,
                        accessibilityLabel: addPlaceholder,
                        placeholder: addPlaceholder,
                        size: .sm,
                        onCommit: commitDraft
                    )
                    .frame(width: 120)
                }
            }
        }
    }

    private func selectChip(_ chip: MuiChip) -> some View {
        let isSelected = chip.id == selectedId
        return Button {
            selectedId = Self.nextSelection(current: selectedId, tapped: chip.id)
        } label: {
            MuiBadge(variant: isSelected ? .signal : .count, value: chip.label)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }

    /// The selection after tapping chip `tapped` — `select` mode is a
    /// single-select row with no toggle-off (tapping the already-selected
    /// chip is a no-op re-selection, not a clear), unlike a checkbox or a
    /// rating star. Public + static so this is unit-testable without
    /// rendering a view.
    public static func nextSelection(current: String?, tapped: String) -> String? {
        tapped
    }

    /// The chip to add for a committed draft string — `nil` when the
    /// trimmed draft is empty, so the caller skips emitting `added` for a
    /// blank submission. Public + static so this is unit-testable without
    /// rendering a view.
    public static func addResult(draft: String) -> String? {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func removableChip(_ chip: MuiChip) -> some View {
        HStack(spacing: 4) {
            MuiBadge(variant: .count, value: chip.label)
            Button {
                removed?(chip.id)
            } label: {
                MuiIcon(name: "xmark", size: .xs, color: MuiTokens.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(chip.label)")
        }
    }

    private func commitDraft() {
        guard let next = Self.addResult(draft: draft) else { return }
        added?(next)
        draft = ""
    }
}

#Preview("MuiChipRow — Modes") {
    struct Demo: View {
        @State private var selected: String? = "raw"

        var body: some View {
            VStack(alignment: .leading, spacing: 16) {
                MuiChipRow(
                    chips: [MuiChip(id: "raw", label: "RAW"), MuiChip(id: "jpeg", label: "JPEG"), MuiChip(id: "video", label: "Video")],
                    mode: .select,
                    selectedId: $selected
                )
                MuiChipRow(
                    chips: [MuiChip(id: "1", label: "Sunset"), MuiChip(id: "2", label: "Portrait")],
                    mode: .removable
                )
                MuiChipRow(
                    chips: [MuiChip(id: "1", label: "Wildlife")],
                    mode: .editable
                )
            }
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
