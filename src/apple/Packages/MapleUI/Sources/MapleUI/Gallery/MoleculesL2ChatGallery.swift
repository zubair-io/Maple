// MoleculesL2ChatGallery.swift — Molecules L2 tab, catalog §3 chat/
// scheduling group: Chat Message, Typing Indicator, Todo Popover, Event
// Popover. The two popovers are pinned open via `open: .constant(true)`,
// the same "static grid, panel pinned open" convention
// MoleculesL1OverlaysMenusGallery uses for its own overlay menus.

import SwiftUI

extension MoleculesL2GallerySection {
    var chatMessageCard: some View {
        GallerySpecimenCard(name: "Chat Message", purpose: "One message bubble", builtFrom: "Avatar, Text, Timestamp") {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                MuiChatMessage(author: "Ada Lovelace", text: "Can you export the Iceland set?", sentAt: Date().addingTimeInterval(-300))
                MuiChatMessage(author: "You", text: "On it now.", sentAt: Date().addingTimeInterval(-60), own: true)
            }
        }
    }

    var typingIndicatorCard: some View {
        GallerySpecimenCard(name: "Typing Indicator", purpose: "Someone-is-typing affordance", builtFrom: "Avatar, Text") {
            MuiTypingIndicator(name: "Ada")
        }
    }

    var todoPopoverCard: some View {
        GallerySpecimenCard(name: "Todo Popover", purpose: "Task attribute editor", builtFrom: "Popover, Form Field, Chip Row") {
            MuiTodoPopover(open: .constant(true), title: .constant("Ship feature"), priority: .constant("medium"), dueLabel: .constant("Fri")) {
                MuiButton(label: "Task", variant: .secondary) {}
            }
            .padding(.bottom, 130)
        }
    }

    var eventPopoverCard: some View {
        GallerySpecimenCard(name: "Event Popover", purpose: "Calendar event create/edit", builtFrom: "Popover, Form Field, Button") {
            MuiEventPopover(open: .constant(true), title: .constant("Design review"), timeLabel: .constant("3:00 PM")) {
                MuiButton(label: "Event", variant: .secondary) {}
            }
            .padding(.bottom, 130)
        }
    }
}
