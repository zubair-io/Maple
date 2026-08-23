// MoleculesL2MediaGallery.swift — Molecules L2 tab, catalog §3 media/grid
// group: Media Cell, Card, Filmstrip Row, Filmstrip Rail, QR Scanner.

import SwiftUI

extension MoleculesL2GallerySection {
    var mediaCellCard: some View {
        GallerySpecimenCard(name: "Media Cell", purpose: "Thumbnail with badges, rating, selection", builtFrom: "Image, Badge, Rating & Flags, Inline Rename Field") {
            HStack(alignment: .top, spacing: MuiTokens.spacingSm) {
                MuiMediaCell(url: nil, alt: "Sunset", filename: .constant("IMG_0042.dng"), badges: ["RAW"], selected: true, rating: .constant(3), flag: .constant(.pick))
                MuiMediaCell(url: nil, alt: "Portrait", filename: .constant("IMG_0043.jpg"), size: .sm)
            }
        }
    }

    var cardCard: some View {
        GallerySpecimenCard(name: "Card", purpose: "Image + title + metadata tile", builtFrom: "Image, Text, Badge") {
            MuiCard(url: nil, alt: "Trip cover", title: "Iceland 2026", subtitle: "214 photos", badgeLabel: "New")
        }
    }

    var filmstripRowCard: some View {
        GallerySpecimenCard(name: "Filmstrip Row", purpose: "Horizontal scrolling thumbnails", builtFrom: "Media Cell") {
            MuiFilmstripRow(
                items: [
                    MuiFilmstripItem(id: "1", url: nil, alt: "Frame 1"),
                    MuiFilmstripItem(id: "2", url: nil, alt: "Frame 2"),
                    MuiFilmstripItem(id: "3", url: nil, alt: "Frame 3"),
                ],
                activeId: .constant("2")
            )
        }
    }

    var filmstripRailCard: some View {
        GallerySpecimenCard(name: "Filmstrip Rail", purpose: "Collapsible vertical thumbnails", builtFrom: "Media Cell, Icon") {
            HStack(alignment: .top, spacing: MuiTokens.spacingMd) {
                MuiFilmstripRail(
                    items: [MuiFilmstripItem(id: "1", url: nil, alt: "Frame 1"), MuiFilmstripItem(id: "2", url: nil, alt: "Frame 2")],
                    activeId: .constant("1")
                )
                MuiFilmstripRail(items: [MuiFilmstripItem(id: "1", url: nil, alt: "Frame 1")], collapsed: .constant(true))
            }
        }
    }

    var qrScannerCard: some View {
        GallerySpecimenCard(name: "QR Scanner", purpose: "Camera or paste payload capture", builtFrom: "Input, Button, Canvas Surface") {
            MuiQrScanner()
                .frame(width: 220)
        }
    }
}
