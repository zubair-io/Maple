// MoleculesL1StructureGallery.swift — Molecules L1 tab, catalog §2.5
// Structure: Collapsible, Page Header, Toolbar, Bubble Menu,
// Label-Value Grid, Avatar Group.

import SwiftUI

extension MoleculesL1GallerySection2 {
    var collapsibleCard: some View {
        GallerySpecimenCard(name: "Collapsible", purpose: "Disclosure header + content region", builtFrom: "Icon, Text") {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                MuiCollapsible(label: "Expanded", open: .constant(true)) {
                    MuiText("Content region", variant: .body, color: .muted)
                }
                MuiCollapsible(label: "Collapsed", open: .constant(false)) {
                    MuiText("Content region", variant: .body, color: .muted)
                }
            }
        }
    }

    var pageHeaderCard: some View {
        GallerySpecimenCard(name: "Page Header", purpose: "Title bar with back and actions", builtFrom: "Button, Text, Icon") {
            VStack(spacing: MuiTokens.spacingXs) {
                MuiPageHeader(title: "IMG_0042.dng", showMore: true)
                MuiPageHeader(title: "Settings", showBack: false)
            }
        }
    }

    var toolbarCard: some View {
        GallerySpecimenCard(name: "Toolbar", purpose: "Row of actions with overflow", builtFrom: "Action Button, Divider, Icon") {
            MuiToolbar(
                entries: [
                    .item(MuiToolbarActionItem(id: "crop", icon: "crop", label: "Crop")),
                    .item(MuiToolbarActionItem(id: "rotate", icon: "rotate.right", label: "Rotate")),
                    .item(MuiToolbarActionItem(id: "export", icon: "square.and.arrow.up", label: "Export")),
                ],
                maxVisible: 1,
                itemSelected: { _ in }
            )
        }
    }

    var bubbleMenuCard: some View {
        GallerySpecimenCard(name: "Bubble Menu", purpose: "Floating contextual format bar", builtFrom: "Icon, Divider") {
            MuiBubbleMenu(
                open: .constant(true),
                entries: [
                    .item(MuiBubbleMenuItem(id: "bold", icon: "bold", label: "Bold", active: true)),
                    .item(MuiBubbleMenuItem(id: "italic", icon: "italic", label: "Italic")),
                    .divider,
                    .item(MuiBubbleMenuItem(id: "link", icon: "link", label: "Link")),
                ],
                itemSelected: { _ in }
            ) {
                Rectangle().fill(MuiTokens.surfaceAlt).frame(width: 120, height: 40)
            }
            .padding(.bottom, 44)
        }
    }

    var labelValueGridCard: some View {
        GallerySpecimenCard(name: "Label-Value Grid", purpose: "Two-column metadata grid", builtFrom: "Text") {
            MuiLabelValueGrid(rows: [
                MuiLabelValueRow(label: "Camera", value: "DJI Mavic 3 Pro"),
                MuiLabelValueRow(label: "ISO", value: "100"),
                MuiLabelValueRow(label: "Aperture", value: "f/2.8"),
            ])
        }
    }

    var avatarGroupCard: some View {
        GallerySpecimenCard(name: "Avatar Group", purpose: "Overlapping avatars with overflow", builtFrom: "Avatar, Badge") {
            MuiAvatarGroup(avatars: [
                MuiAvatarGroupMember(name: "Ada Lovelace"),
                MuiAvatarGroupMember(name: "Grace Hopper"),
                MuiAvatarGroupMember(name: "Margaret Hamilton"),
                MuiAvatarGroupMember(name: "Katherine Johnson"),
            ])
        }
    }
}
