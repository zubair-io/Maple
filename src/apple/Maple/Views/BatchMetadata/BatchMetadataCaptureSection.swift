// BatchMetadataCaptureSection.swift — "Capture" section of the Batch Metadata sheet.
// Covers GPS location (address search + manual lat/lon), capture date/time,
// and time zone.
//
// CLGeocoder is used for forward geocode (Apple standalone, no server).
// GPS fields on touchedMetadata are populated when the user picks a result.
//
// Ticket #1629 / epic #1575.

import SwiftUI
import CoreLocation
import MapleCore

// MARK: - BatchMetadataCaptureSection

struct BatchMetadataCaptureSection: View {
    @Bindable var vm: BatchMetadataViewModel

    // Address search state
    @State private var addressQuery: String = ""
    @State private var geocodeResults: [CLPlacemark] = []
    @State private var isGeocoding: Bool = false
    @State private var geocodeError: String? = nil
    @State private var geocoder = CLGeocoder()

    // Manual lat/lon/alt text field buffers (parse to Double on change)
    @State private var latText: String = ""
    @State private var lonText: String = ""
    @State private var altText: String = ""

    // Date/time and timezone text field buffers
    @State private var dateTimeText: String = ""
    @State private var timeZoneText: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionHeader("Capture")
            locationGroup
            Divider().padding(.leading, 16)
            dateTimeGroup
        }
    }

    // MARK: - Location Group

    private var locationGroup: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("GPS Location")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 16)
                .padding(.top, 12)

            // Address search row
            HStack {
                TextField("Search address…", text: $addressQuery)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { runGeocode() }
                if isGeocoding {
                    ProgressView().controlSize(.small)
                }
                Button("Search") { runGeocode() }
                    .disabled(addressQuery.trimmingCharacters(in: .whitespaces).isEmpty || isGeocoding)
            }
            .padding(.horizontal, 16)

            if let err = geocodeError {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 16)
            }

            // Geocode results picker (shown only when results are available)
            if !geocodeResults.isEmpty {
                Picker("Result", selection: Binding<CLPlacemark?>(
                    get: { nil },
                    set: { if let p = $0 { applyPlacemark(p) } }
                )) {
                    Text("Select result…").tag(Optional<CLPlacemark>(nil))
                    ForEach(geocodeResults, id: \.description) { p in
                        Text(placemarkLabel(p)).tag(Optional(p))
                    }
                }
                .pickerStyle(.menu)
                .padding(.horizontal, 16)
            }

            // Manual lat/lon entry
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Latitude").font(.caption).foregroundStyle(.secondary)
                    TextField(latPlaceholder, text: $latText)
                        .textFieldStyle(.roundedBorder)
                        .onChange(of: latText) { _, v in
                            if let d = Double(v) {
                                vm.touchedMetadata.gpsLatitude = .some(d)
                            } else if v.isEmpty {
                                vm.touchedMetadata.gpsLatitude = nil
                            }
                        }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Longitude").font(.caption).foregroundStyle(.secondary)
                    TextField(lonPlaceholder, text: $lonText)
                        .textFieldStyle(.roundedBorder)
                        .onChange(of: lonText) { _, v in
                            if let d = Double(v) {
                                vm.touchedMetadata.gpsLongitude = .some(d)
                            } else if v.isEmpty {
                                vm.touchedMetadata.gpsLongitude = nil
                            }
                        }
                }
            }
            .padding(.horizontal, 16)

            // Altitude field (manual entry, mirrors web "Altitude (meters)").
            VStack(alignment: .leading, spacing: 4) {
                Text("Altitude (m)").font(.caption).foregroundStyle(.secondary)
                TextField(altPlaceholder, text: $altText)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: altText) { _, v in
                        if let d = Double(v) {
                            vm.touchedMetadata.gpsAltitude = .some(d)
                        } else if v.isEmpty {
                            // Empty = untouched (not an explicit clear; use Clear GPS for that)
                            vm.touchedMetadata.gpsAltitude = nil
                        }
                    }
            }
            .padding(.horizontal, 16)

            // Clear GPS button — shown whenever there is GPS to clear (existing,
            // mixed, or just-entered), so the user can remove coordinates without
            // first having to edit one. Clears lat/lon/alt atomically.
            if hasGpsToClear {
                Button("Clear GPS") {
                    vm.touchedMetadata.gpsLatitude  = .some(nil)
                    vm.touchedMetadata.gpsLongitude = .some(nil)
                    vm.touchedMetadata.gpsAltitude  = .some(nil)
                    latText = ""
                    lonText = ""
                    altText = ""
                    geocodeResults = []
                }
                .font(.subheadline)
                .foregroundStyle(.red)
                .padding(.horizontal, 16)
            }
        }
        .padding(.bottom, 12)
    }

    // MARK: - Date/Time Group

    private var dateTimeGroup: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Date & Time")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 16)
                .padding(.top, 12)

            VStack(alignment: .leading, spacing: 4) {
                Text("Capture date/time (ISO-8601)").font(.caption).foregroundStyle(.secondary)
                TextField(dateTimePlaceholder, text: $dateTimeText)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: dateTimeText) { _, v in
                        // Empty = explicit clear (apply() maps "" → nil); editing
                        // to empty therefore clears the field across the selection.
                        vm.touchedMetadata.dateTimeOriginal = v
                    }
            }
            .padding(.horizontal, 16)

            VStack(alignment: .leading, spacing: 4) {
                Text("Time zone (IANA, e.g. Europe/Paris)").font(.caption).foregroundStyle(.secondary)
                TextField(timeZonePlaceholder, text: $timeZoneText)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: timeZoneText) { _, v in
                        vm.touchedMetadata.timeZone = v
                    }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
        }
    }

    // MARK: - Geocode

    private func runGeocode() {
        let q = addressQuery.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        isGeocoding = true
        geocodeError = nil
        geocodeResults = []
        geocoder.cancelGeocode()
        geocoder.geocodeAddressString(q) { placemarks, error in
            Task { @MainActor in
                isGeocoding = false
                if let err = error {
                    geocodeError = err.localizedDescription
                } else {
                    geocodeResults = placemarks ?? []
                }
            }
        }
    }

    private func applyPlacemark(_ p: CLPlacemark) {
        guard let loc = p.location else { return }
        let lat = loc.coordinate.latitude
        let lon = loc.coordinate.longitude
        vm.touchedMetadata.gpsLatitude  = lat
        vm.touchedMetadata.gpsLongitude = lon
        latText = String(format: "%.6f", lat)
        lonText = String(format: "%.6f", lon)
        // Apply altitude only when CoreLocation reports it as valid: a positive
        // verticalAccuracy means the altitude is measured. (A zero/negative
        // verticalAccuracy means altitude is invalid — don't confuse that with
        // a genuine 0 m sea-level reading, which is valid and must be applied.)
        if loc.verticalAccuracy > 0 {
            let alt = loc.altitude
            vm.touchedMetadata.gpsAltitude = alt
            altText = String(format: "%.1f", alt)
        }
        // Populate place-text fields from placemark when available
        if let city    = p.locality             { vm.touchedMetadata.city        = city    }
        if let state   = p.administrativeArea   { vm.touchedMetadata.state       = state   }
        if let country = p.country              { vm.touchedMetadata.country     = country }
        if let code    = p.isoCountryCode       { vm.touchedMetadata.countryCode = code    }
        geocodeResults = []
        addressQuery   = ""
    }

    // MARK: - Helpers

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.headline)
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 4)
    }

    /// True when there are GPS coordinates to clear: just-entered (touched),
    /// shared across the selection (common), or differing (mixed).
    private var hasGpsToClear: Bool {
        vm.touchedMetadata.gpsLatitude != nil || vm.touchedMetadata.gpsLongitude != nil
            || vm.touchedMetadata.gpsAltitude != nil
            || vm.commonMetadata.gpsLatitude != nil || vm.commonMetadata.gpsLongitude != nil
            || vm.commonMetadata.gpsAltitude != nil
            || vm.mixedFields.contains(.gpsLatitude) || vm.mixedFields.contains(.gpsLongitude)
            || vm.mixedFields.contains(.gpsAltitude)
    }

    private func placemarkLabel(_ p: CLPlacemark) -> String {
        [p.name, p.locality, p.country]
            .compactMap { $0 }
            .joined(separator: ", ")
    }

    private var latPlaceholder: String {
        vm.mixedFields.contains(.gpsLatitude) ? "(mixed)" :
            vm.commonMetadata.gpsLatitude.map { String(format: "%.6f", $0) } ?? ""
    }

    private var lonPlaceholder: String {
        vm.mixedFields.contains(.gpsLongitude) ? "(mixed)" :
            vm.commonMetadata.gpsLongitude.map { String(format: "%.6f", $0) } ?? ""
    }

    private var altPlaceholder: String {
        vm.mixedFields.contains(.gpsAltitude) ? "(mixed)" :
            vm.commonMetadata.gpsAltitude.map { String(format: "%.1f", $0) } ?? ""
    }

    private var dateTimePlaceholder: String {
        vm.mixedFields.contains(.dateTimeOriginal) ? "(mixed)" :
            vm.commonMetadata.dateTimeOriginal ?? ""
    }

    private var timeZonePlaceholder: String {
        vm.mixedFields.contains(.timeZone) ? "(mixed)" :
            vm.commonMetadata.timeZone ?? ""
    }
}

// MARK: - Preview

#Preview {
    BatchMetadataCaptureSection(
        vm: BatchMetadataViewModel(
            assets: [AssetRef(url: URL(fileURLWithPath: "/tmp/test.dng"))],
            sessions: [:]
        )
    )
}
