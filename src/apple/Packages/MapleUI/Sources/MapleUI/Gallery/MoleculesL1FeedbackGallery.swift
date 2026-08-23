// MoleculesL1FeedbackGallery.swift — Molecules L1 tab, catalog §2.3
// Feedback & messaging: Banner, Toast Container, Empty State, Value Chip,
// Value HUD, Frame-time HUD.

import SwiftUI

extension MoleculesL1GallerySection {
    var bannerCard: some View {
        GallerySpecimenCard(name: "Banner", purpose: "Inline status strip", builtFrom: "Icon, Text, Link, Button") {
            VStack(spacing: MuiTokens.spacingSm) {
                MuiBanner(variant: .success, message: "Export finished.", dismissible: true)
                MuiBanner(variant: .warning, message: "3 photos are missing their originals.", actionLabel: "Review")
            }
        }
    }

    var toastContainerCard: some View {
        GallerySpecimenCard(name: "Toast Container", purpose: "Stacks and positions toasts", builtFrom: "Toast") {
            MuiToastContainer(
                toasts: [
                    MuiToastEntry(id: "1", variant: .success, message: "Export finished", autoDismissMs: nil),
                    MuiToastEntry(id: "2", variant: .error, message: "Batch failed", actionLabel: "Retry", autoDismissMs: nil),
                ],
                position: .bottomRight
            )
        }
    }

    var emptyStateCard: some View {
        GallerySpecimenCard(name: "Empty State", purpose: "Icon, title, message, optional action", builtFrom: "Icon, Text, Button") {
            MuiEmptyState(icon: "photo.on.rectangle.angled", title: "No photos yet", message: "Import a folder to get started.", actionLabel: "Import")
        }
    }

    var valueChipCard: some View {
        GallerySpecimenCard(name: "Value Chip", purpose: "Floating value readout during a drag", builtFrom: "Badge, Text") {
            HStack(spacing: MuiTokens.spacingSm) {
                MuiValueChip(label: "Exposure", value: "+0.35")
                MuiValueChip(label: "Temp", value: "5800K")
            }
        }
    }

    var valueHUDCard: some View {
        GallerySpecimenCard(name: "Value HUD", purpose: "Center-screen scrub overlay", builtFrom: "Text, Progress") {
            MuiValueHUD(label: "Export", value: "42%", progressPct: 42)
        }
    }

    var frameTimeHUDCard: some View {
        GallerySpecimenCard(name: "Frame-time HUD", purpose: "Performance readout overlay", builtFrom: "Text") {
            VStack(spacing: MuiTokens.spacingSm) {
                MuiFrameTimeHUD(frameMs: 11.2)
                MuiFrameTimeHUD(frameMs: 62.1)
            }
        }
    }
}
