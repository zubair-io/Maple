// BatchMetadataTextSection.swift — "Location", "Description", and "Creator & Rights"
// sections of the Batch Metadata sheet. All plain-text IPTC fields.
//
// Ticket #1629 / epic #1575.

import SwiftUI
import MapleCore

// MARK: - BatchMetadataTextSection

struct BatchMetadataTextSection: View {
    @Bindable var vm: BatchMetadataViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            locationGroup
            Divider()
            descriptionGroup
            Divider()
            rightsGroup
        }
    }

    // MARK: - Location text

    private var locationGroup: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Location")
            metadataTextField("Sublocation",     placeholder: placeholder(.sublocation),
                              value: Binding(get: { vm.touchedMetadata.sublocation  ?? "" },
                                            set: { vm.touchedMetadata.sublocation  = $0.isEmpty ? nil : $0 }))
            metadataTextField("City",            placeholder: placeholder(.city),
                              value: Binding(get: { vm.touchedMetadata.city         ?? "" },
                                            set: { vm.touchedMetadata.city         = $0.isEmpty ? nil : $0 }))
            metadataTextField("State / Province", placeholder: placeholder(.state),
                              value: Binding(get: { vm.touchedMetadata.state        ?? "" },
                                            set: { vm.touchedMetadata.state        = $0.isEmpty ? nil : $0 }))
            metadataTextField("Country",         placeholder: placeholder(.country),
                              value: Binding(get: { vm.touchedMetadata.country      ?? "" },
                                            set: { vm.touchedMetadata.country      = $0.isEmpty ? nil : $0 }))
            metadataTextField("Country Code",    placeholder: placeholder(.countryCode),
                              value: Binding(get: { vm.touchedMetadata.countryCode  ?? "" },
                                            set: { vm.touchedMetadata.countryCode  = $0.isEmpty ? nil : $0 }))
        }
        .padding(.bottom, 12)
    }

    // MARK: - Description

    private var descriptionGroup: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Description")
            metadataTextField("Title",            placeholder: placeholder(.title),
                              value: Binding(get: { vm.touchedMetadata.title        ?? "" },
                                            set: { vm.touchedMetadata.title        = $0.isEmpty ? nil : $0 }))
            metadataTextField("Caption (Notes)",  placeholder: placeholder(.caption),
                              value: Binding(get: { vm.touchedMetadata.caption      ?? "" },
                                            set: { vm.touchedMetadata.caption      = $0.isEmpty ? nil : $0 }))
            metadataTextField("Headline",         placeholder: placeholder(.headline),
                              value: Binding(get: { vm.touchedMetadata.headline     ?? "" },
                                            set: { vm.touchedMetadata.headline     = $0.isEmpty ? nil : $0 }))
            metadataTextField("Instructions",     placeholder: placeholder(.instructions),
                              value: Binding(get: { vm.touchedMetadata.instructions ?? "" },
                                            set: { vm.touchedMetadata.instructions = $0.isEmpty ? nil : $0 }))
        }
        .padding(.bottom, 12)
    }

    // MARK: - Creator & Rights

    private var rightsGroup: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Creator & Rights")
            metadataTextField("Creator / Author",   placeholder: placeholder(.creator),
                              value: Binding(get: { vm.touchedMetadata.creator          ?? "" },
                                            set: { vm.touchedMetadata.creator          = $0.isEmpty ? nil : $0 }))
            metadataTextField("Creator Job Title",  placeholder: placeholder(.creatorJobTitle),
                              value: Binding(get: { vm.touchedMetadata.creatorJobTitle  ?? "" },
                                            set: { vm.touchedMetadata.creatorJobTitle  = $0.isEmpty ? nil : $0 }))
            metadataTextField("Copyright Notice",   placeholder: placeholder(.copyrightNotice),
                              value: Binding(get: { vm.touchedMetadata.copyrightNotice  ?? "" },
                                            set: { vm.touchedMetadata.copyrightNotice  = $0.isEmpty ? nil : $0 }))
            copyrightStatusPicker
            metadataTextField("Usage Terms",        placeholder: placeholder(.usageTerms),
                              value: Binding(get: { vm.touchedMetadata.usageTerms       ?? "" },
                                            set: { vm.touchedMetadata.usageTerms       = $0.isEmpty ? nil : $0 }))
            metadataTextField("Credit",             placeholder: placeholder(.credit),
                              value: Binding(get: { vm.touchedMetadata.credit           ?? "" },
                                            set: { vm.touchedMetadata.credit           = $0.isEmpty ? nil : $0 }))
            metadataTextField("Source",             placeholder: placeholder(.source),
                              value: Binding(get: { vm.touchedMetadata.source           ?? "" },
                                            set: { vm.touchedMetadata.source           = $0.isEmpty ? nil : $0 }))
        }
        .padding(.bottom, 24)
    }

    // MARK: - Copyright status tri-state picker

    private var copyrightStatusPicker: some View {
        // Binding: outer nil = untouched (show common value as hint); setting any
        // value marks the field touched. The outer Optional<Optional<CopyrightStatus>>
        // is collapsed: we read/write the inner Optional<CopyrightStatus>.
        let pickerBinding = Binding<CopyrightStatus?>(
            get: {
                // If the user has touched it, show the touched value; otherwise show common.
                if let outer = vm.touchedMetadata.copyrightStatus {
                    return outer
                }
                return vm.commonMetadata.copyrightStatus
            },
            set: { newValue in
                // Wrap in outer Optional to mark field as touched.
                vm.touchedMetadata.copyrightStatus = .some(newValue)
            }
        )

        return HStack {
            Text("Copyright Status")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(width: 140, alignment: .leading)
            Picker("Copyright Status", selection: pickerBinding) {
                Text("(not set)").tag(Optional<CopyrightStatus>(nil))
                Text("Unknown").tag(Optional(CopyrightStatus.unknown))
                Text("Copyrighted").tag(Optional(CopyrightStatus.copyrighted))
                Text("Public Domain").tag(Optional(CopyrightStatus.publicDomain))
            }
            .pickerStyle(.segmented)
            if vm.mixedFields.contains(.copyrightStatus) {
                Text("(mixed)").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 16)
    }

    // MARK: - Shared helpers

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.headline)
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 4)
    }

    private func metadataTextField(_ label: String, placeholder: String,
                                   value: Binding<String>) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(width: 140, alignment: .leading)
            TextField(placeholder, text: value)
                .textFieldStyle(.roundedBorder)
        }
        .padding(.horizontal, 16)
    }

    /// Placeholder string for a field: "(mixed)" when the selection has
    /// heterogeneous values; the common value string when all assets agree;
    /// or empty string when no value is set.
    private func placeholder(_ key: MetadataFieldKey) -> String {
        vm.mixedFields.contains(key) ? "(mixed)" : fieldValue(key)
    }

    private func fieldValue(_ key: MetadataFieldKey) -> String {
        switch key {
        case .sublocation:      return vm.commonMetadata.sublocation     ?? ""
        case .city:             return vm.commonMetadata.city            ?? ""
        case .state:            return vm.commonMetadata.state           ?? ""
        case .country:          return vm.commonMetadata.country         ?? ""
        case .countryCode:      return vm.commonMetadata.countryCode     ?? ""
        case .title:            return vm.commonMetadata.title           ?? ""
        case .caption:          return vm.commonMetadata.caption         ?? ""
        case .headline:         return vm.commonMetadata.headline        ?? ""
        case .instructions:     return vm.commonMetadata.instructions    ?? ""
        case .creator:          return vm.commonMetadata.creator         ?? ""
        case .creatorJobTitle:  return vm.commonMetadata.creatorJobTitle ?? ""
        case .copyrightNotice:  return vm.commonMetadata.copyrightNotice ?? ""
        case .usageTerms:       return vm.commonMetadata.usageTerms      ?? ""
        case .credit:           return vm.commonMetadata.credit          ?? ""
        case .source:           return vm.commonMetadata.source          ?? ""
        default:                return ""
        }
    }
}

// MARK: - Preview

#Preview {
    ScrollView {
        BatchMetadataTextSection(
            vm: BatchMetadataViewModel(
                assets: [AssetRef(url: URL(fileURLWithPath: "/tmp/test.dng"))],
                sessions: [:]
            )
        )
    }
}
