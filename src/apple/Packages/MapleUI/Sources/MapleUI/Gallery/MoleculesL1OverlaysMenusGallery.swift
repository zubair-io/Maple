// MoleculesL1OverlaysMenusGallery.swift — Molecules L1 tab, catalog §2.4
// Overlays & menus: Popover, Context Menu, Suggestion Menu, Command Menu.
// Each specimen shows its trigger with the panel pinned open via a
// `.constant(true)` binding, so the gallery's static grid can display the
// panel content without needing per-card interaction state.

import SwiftUI

extension MoleculesL1GallerySection2 {
    var popoverCard: some View {
        GallerySpecimenCard(name: "Popover", purpose: "Anchored floating container", builtFrom: "(none — positioning primitive)") {
            MuiButton(label: "Trigger", variant: .secondary) {}
                .muiPopover(isPresented: true, placement: .bottom, closeRequested: {}) {
                    MuiText("Panel content", variant: .body, color: .muted)
                        .frame(width: 140)
                }
                .padding(.bottom, 56)
        }
    }

    var contextMenuCard: some View {
        GallerySpecimenCard(name: "Context Menu", purpose: "Keyboard-navigable action list", builtFrom: "Popover, Icon, Text, Divider") {
            MuiContextMenu(
                open: .constant(true),
                entries: [
                    .item(MuiContextMenuItem(id: "rename", label: "Rename", icon: "pencil")),
                    .divider,
                    .item(MuiContextMenuItem(id: "delete", label: "Delete", icon: "trash", destructive: true)),
                ],
                select: { _ in }
            ) {
                MuiButton(label: "Actions", variant: .secondary, trailingIcon: "chevron.down") {}
            }
            .padding(.bottom, 90)
        }
    }

    var suggestionMenuCard: some View {
        GallerySpecimenCard(name: "Suggestion Menu", purpose: "Query-driven autocomplete list", builtFrom: "Popover, Icon, Text") {
            MuiSuggestionMenu(
                open: .constant(true),
                items: [
                    MuiSuggestionItem(id: "ada", label: "Ada Lovelace", icon: "person.crop.circle"),
                    MuiSuggestionItem(id: "grace", label: "Grace Hopper", icon: "person.crop.circle"),
                ],
                select: { _ in }
            ) {
                MuiButton(label: "@mention", variant: .secondary) {}
            }
            .padding(.bottom, 80)
        }
    }

    var commandMenuCard: some View {
        GallerySpecimenCard(name: "Command Menu", purpose: "Searchable command palette", builtFrom: "Popover, Input, Icon, Text") {
            MuiCommandMenu(
                open: .constant(true),
                commands: [
                    MuiCommandItem(id: "export", label: "Export…", icon: "square.and.arrow.up", shortcut: "⌘E"),
                    MuiCommandItem(id: "crop", label: "Crop", icon: "crop"),
                ],
                select: { _ in }
            ) {
                MuiButton(label: "Command palette", variant: .secondary, leadingIcon: "command") {}
            }
            .padding(.bottom, 120)
        }
    }
}
