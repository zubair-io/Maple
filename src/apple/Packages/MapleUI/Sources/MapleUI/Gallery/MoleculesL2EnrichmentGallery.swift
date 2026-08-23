// MoleculesL2EnrichmentGallery.swift — Molecules L2 tab, catalog §3
// enrichment group: Description Field, Transcript Block, Faces Row, Place
// Row, Vision Row, Keyword Row.

import SwiftUI

extension MoleculesL2GallerySection {
    var descriptionFieldCard: some View {
        GallerySpecimenCard(name: "Description Field", purpose: "Text with override and regenerate", builtFrom: "Text, Input, Button") {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                MuiDescriptionField(value: .constant("A red fox crossing a snowy field at dusk."))
                MuiDescriptionField(value: .constant(""), regenerating: true)
            }
        }
    }

    var transcriptBlockCard: some View {
        GallerySpecimenCard(name: "Transcript Block", purpose: "Timestamped read-only transcript", builtFrom: "Text, Timestamp") {
            MuiTranscriptBlock(
                baseTime: Date(),
                entries: [
                    MuiTranscriptEntry(id: "1", offsetMs: 0, speaker: "Ada", text: "Let's start."),
                    MuiTranscriptEntry(id: "2", offsetMs: 4200, speaker: "Grace", text: "Sounds good."),
                ]
            )
        }
    }

    var facesRowCard: some View {
        GallerySpecimenCard(name: "Faces Row", purpose: "Count, person chips, re-detect", builtFrom: "Chip Row, Button, Text") {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                MuiFacesRow(people: [MuiChip(id: "1", label: "Ada"), MuiChip(id: "2", label: "Grace")], selectedId: .constant("1"))
                MuiFacesRow(people: [], redetecting: true)
            }
        }
    }

    var placeRowCard: some View {
        GallerySpecimenCard(name: "Place Row", purpose: "Geocoded place with override", builtFrom: "Text, Input, Button") {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                MuiPlaceRow(place: .constant("Reykjavík, Iceland"), overridden: true)
                MuiPlaceRow(place: .constant(""))
            }
        }
    }

    var visionRowCard: some View {
        GallerySpecimenCard(name: "Vision Row", purpose: "Classification result chips", builtFrom: "Chip Row") {
            MuiVisionRow(labels: [MuiChip(id: "1", label: "Mountain"), MuiChip(id: "2", label: "Snow"), MuiChip(id: "3", label: "Sunset")])
        }
    }

    var keywordRowCard: some View {
        GallerySpecimenCard(name: "Keyword Row", purpose: "Editable tag chips", builtFrom: "Chip Row, Input") {
            MuiKeywordRow(keywords: [MuiChip(id: "1", label: "landscape"), MuiChip(id: "2", label: "wildlife")])
        }
    }
}
