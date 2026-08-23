// AtomsGalleryView.swift — Atoms tab: specimen cards for all 22 atoms —
// wave 1's 10 (catalog §1.1 Actions, §1.2 Content) plus wave 2's 12 (§1.3
// Form controls, §1.4 Media, §1.5 Feedback).

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
                inputCard
                checkboxCard
                segmentedToggleCard
                imageCard
                remoteImageCard
                avatarCard
                qrCodeCard
                canvasSurfaceCard
                progressCard
                spinnerCard
                statusTextCard
                toastCard
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

    private var inputCard: some View {
        GallerySpecimenCard(name: "Input", purpose: "Single-line text field") {
            VStack(spacing: MuiTokens.spacingSm) {
                MuiInput(value: .constant(""), accessibilityLabel: "Search", placeholder: "Search…", prefixIcon: "magnifyingglass", showClear: true)
                MuiInput(value: .constant("bad-value"), accessibilityLabel: "Email", error: "Enter a valid email")
            }
        }
    }

    private var checkboxCard: some View {
        GallerySpecimenCard(name: "Checkbox", purpose: "Labeled boolean") {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                MuiCheckbox(state: .checked, label: "Checked") {}
                MuiCheckbox(state: .unchecked, label: "Unchecked") {}
                MuiCheckbox(state: .indeterminate, label: "Mixed") {}
            }
        }
    }

    private var segmentedToggleCard: some View {
        GallerySpecimenCard(name: "Segmented Toggle", purpose: "2-3 exclusive options") {
            MuiSegmentedToggle(
                options: [
                    MuiSegmentedOption(value: "grid", label: "Grid"),
                    MuiSegmentedOption(value: "list", label: "List"),
                ],
                value: .constant("grid")
            )
        }
    }

    private var imageCard: some View {
        GallerySpecimenCard(name: "Image", purpose: "Raster leaf") {
            HStack(spacing: MuiTokens.spacingSm) {
                MuiImage(url: nil, alt: "Broken placeholder", radius: .md)
                    .frame(width: 56, height: 56)
                MuiImage(url: nil, alt: "Broken placeholder", radius: .full)
                    .frame(width: 56, height: 56)
            }
        }
    }

    private var remoteImageCard: some View {
        // Showcase feeds a local/generated image via an injected loader —
        // the gallery never talks to the network (component brief).
        GallerySpecimenCard(name: "Remote Image", purpose: "Tiered thumb → preview → full load") {
            MuiRemoteImage(
                tiers: MuiRemoteImageTiers(thumb: URL(string: "demo://thumb"), full: URL(string: "demo://full")),
                alt: "Generated demo image",
                loader: { url in
                    try await Task.sleep(nanoseconds: url.absoluteString.contains("thumb") ? 30_000_000 : 200_000_000)
                    return Image(systemName: "mountain.2.fill")
                }
            )
            .frame(width: 96, height: 72)
        }
    }

    private var avatarCard: some View {
        GallerySpecimenCard(name: "Avatar", purpose: "User image with initials fallback") {
            HStack(spacing: MuiTokens.spacingSm) {
                MuiAvatar(name: "Ada Lovelace", presence: .online)
                MuiAvatar(name: "Grace Hopper", presence: .offline)
                MuiAvatar(name: "Katherine Johnson")
            }
        }
    }

    private var qrCodeCard: some View {
        GallerySpecimenCard(name: "QR Code", purpose: "Renders a payload as a QR image") {
            MuiQrCode(value: "https://maple.app/pair/demo", size: .sm)
        }
    }

    private var canvasSurfaceCard: some View {
        GallerySpecimenCard(name: "Canvas Surface", purpose: "Hosts a GPU-rendered layer") {
            MuiCanvasSurface(contentAspect: 3.0 / 2.0) { size in
                Canvas { context, canvasSize in
                    context.fill(Path(CGRect(origin: .zero, size: canvasSize)), with: .color(MuiTokens.primaryDim))
                }
                .frame(width: size.width, height: size.height)
            }
            .frame(width: 120, height: 90)
        }
    }

    private var progressCard: some View {
        GallerySpecimenCard(name: "Progress", purpose: "Determinate or indeterminate") {
            VStack(spacing: MuiTokens.spacingSm) {
                MuiProgress(shape: .bar, value: 60, label: "60%")
                    .frame(width: 140)
                MuiProgress(shape: .ring, size: .sm, value: 40)
            }
        }
    }

    private var spinnerCard: some View {
        GallerySpecimenCard(name: "Spinner", purpose: "Small indeterminate indicator") {
            HStack(spacing: MuiTokens.spacingSm) {
                MuiSpinner(size: .sm)
                MuiSpinner(size: .md)
            }
        }
    }

    private var statusTextCard: some View {
        GallerySpecimenCard(name: "Status Text", purpose: "Persistence / sync state line") {
            VStack(alignment: .leading, spacing: 4) {
                MuiStatusText(state: .saving)
                MuiStatusText(state: .saved)
                MuiStatusText(state: .error)
            }
        }
    }

    private var toastCard: some View {
        GallerySpecimenCard(name: "Toast", purpose: "Transient notification") {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                MuiToast(variant: .success, message: "Export finished", autoDismissMs: nil)
                MuiToast(variant: .error, message: "Batch failed", actionLabel: "Retry", autoDismissMs: nil)
            }
        }
    }
}

#Preview {
    ScrollView {
        AtomsGalleryView().padding()
    }
    .background(MuiTokens.bg)
}
