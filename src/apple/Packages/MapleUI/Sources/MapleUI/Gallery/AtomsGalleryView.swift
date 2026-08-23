// AtomsGalleryView.swift — Atoms tab: specimen cards for the 10 wave-1
// atoms (catalog §1.1 Actions, §1.2 Content), plus a "coming in a later
// wave" placeholder for the 12 wave-2 atoms (Form controls, Media, Feedback)
// not yet built.

import SwiftUI

struct AtomsGalleryView: View {
    private let columns = [GridItem(.adaptive(minimum: 220), spacing: MuiTokens.spacingMd, alignment: .top)]

    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingLg) {
            LazyVGrid(columns: columns, alignment: .leading, spacing: MuiTokens.spacingMd) {
                buttonCard
                actionButtonCard
                iconCard
                linkCard
                textCard
                timestampCard
                badgeCard
                statCard
                dividerCard
                listCard
            }

            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                MuiText("Wave 2 — coming in a later wave", variant: .eyebrow, color: .muted)
                GalleryPlaceholderSection(names: GalleryCatalog.unbuiltAtoms)
            }
        }
    }

    private var buttonCard: some View {
        GallerySpecimenCard(name: "Button", purpose: "Text action, optional icon") {
            VStack(spacing: MuiTokens.spacingSm) {
                MuiButton(label: "Primary", variant: .primary) {}
                MuiButton(label: "Secondary", variant: .secondary) {}
                MuiButton(label: "Disabled", variant: .primary, disabled: true) {}
            }
        }
    }

    private var actionButtonCard: some View {
        GallerySpecimenCard(name: "Action Button", purpose: "Compact icon+label pill for toolbars") {
            HStack(spacing: MuiTokens.spacingSm) {
                MuiActionButton(icon: "wand.and.stars", label: "Auto") {}
                MuiActionButton(icon: "wand.and.stars", label: "Auto", selected: true) {}
            }
        }
    }

    private var iconCard: some View {
        GallerySpecimenCard(name: "Icon", purpose: "Single glyph") {
            HStack(spacing: MuiTokens.spacingSm) {
                MuiIcon(name: "star.fill", size: .sm, color: MuiTokens.primary)
                MuiIcon(name: "star.fill", size: .md, color: MuiTokens.primary)
                MuiIcon(name: "star.fill", size: .lg, color: MuiTokens.primary)
            }
        }
    }

    private var linkCard: some View {
        GallerySpecimenCard(name: "Link", purpose: "Inline hyperlink") {
            VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
                MuiLink(title: "View details", href: "maple://asset/1")
                MuiLink(title: "Open source", href: "https://example.com", external: true)
            }
        }
    }

    private var textCard: some View {
        GallerySpecimenCard(name: "Text", purpose: "Styled text block") {
            VStack(alignment: .leading, spacing: 4) {
                MuiText("Row label", variant: .rowLabel)
                MuiText("Muted body copy", color: .muted)
            }
        }
    }

    private var timestampCard: some View {
        GallerySpecimenCard(name: "Timestamp", purpose: "Formatted date/time") {
            let now = Date()
            return VStack(alignment: .leading, spacing: 4) {
                MuiTimestamp(value: now.addingTimeInterval(-120), now: now)
                MuiTimestamp(value: now.addingTimeInterval(-2 * 86400), format: .short, now: now)
            }
        }
    }

    private var badgeCard: some View {
        GallerySpecimenCard(name: "Badge", purpose: "Small status label") {
            HStack(spacing: MuiTokens.spacingSm) {
                MuiBadge(variant: .count, value: "3")
                MuiBadge(variant: .signal, value: "Review")
                MuiBadge(variant: .rating, value: "4")
            }
        }
    }

    private var statCard: some View {
        GallerySpecimenCard(name: "Stat", purpose: "Labeled numeric value") {
            HStack(spacing: MuiTokens.spacingLg) {
                MuiStat(value: "128", label: "Photos", size: .sm)
                MuiStat(value: "1.2K", label: "Views", size: .sm, delta: "+12", trend: .up)
            }
        }
    }

    private var dividerCard: some View {
        GallerySpecimenCard(name: "Divider", purpose: "Rule, optional label") {
            VStack(spacing: MuiTokens.spacingSm) {
                MuiDivider()
                MuiDivider(emphasis: .high)
            }
        }
    }

    private var listCard: some View {
        GallerySpecimenCard(name: "List", purpose: "Ordered / unordered items") {
            MuiList(items: [
                MuiListItem(text: "Import"),
                MuiListItem(text: "Cull"),
                MuiListItem(text: "Export"),
            ], density: .compact)
        }
    }
}

#Preview {
    ScrollView {
        AtomsGalleryView().padding()
    }
    .background(MuiTokens.bg)
}
