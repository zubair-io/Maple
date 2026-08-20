// BatchMetadataCaptureSection.swift — "Capture" section of the Batch Metadata sheet.
// Covers GPS location (address search + manual lat/lon), capture date/time,
// and time zone.
//
// Forward geocode is Apple-standalone (no server): MapKit's
// MKGeocodingRequest on iOS (CLGeocoder is deprecated as of iOS 26, our iOS
// deployment target), CLGeocoder on macOS (deployment target 14.0, where it
// is not yet deprecated) — normalized into `GeocodeCandidate` so the picker
// and apply path stay shared. GPS fields on touchedMetadata are populated
// when the user picks a result.
//
// Ticket #1629 / epic #1575.

import SwiftUI
import CoreLocation
import MapleCore
#if os(iOS)
import MapKit
#endif

// MARK: - BatchMetadataCaptureSection

struct BatchMetadataCaptureSection: View {
    @Bindable var vm: BatchMetadataViewModel

    // Address search state
    @State private var addressQuery: String = ""
    @State private var geocodeResults: [GeocodeCandidate] = []
    @State private var isGeocoding: Bool = false
    @State private var geocodeError: String? = nil
    #if os(iOS)
    @State private var activeGeocodeRequest: MKGeocodingRequest? = nil
    #else
    @State private var geocoder = CLGeocoder()
    #endif

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
                Picker("Result", selection: Binding<GeocodeCandidate?>(
                    get: { nil },
                    set: { if let c = $0 { applyCandidate(c) } }
                )) {
                    Text("Select result…").tag(Optional<GeocodeCandidate>(nil))
                    ForEach(geocodeResults) { c in
                        Text(c.label).tag(Optional(c))
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
        #if os(iOS)
        // Supersede any in-flight search: cancel it AND drop it from
        // `activeGeocodeRequest` on every path out of here, so its late
        // completion can never pass the identity guard below and clobber
        // this search's state.
        activeGeocodeRequest?.cancel()
        activeGeocodeRequest = nil
        guard let request = MKGeocodingRequest(addressString: q) else {
            isGeocoding = false
            geocodeError = "Couldn't search for that address."
            return
        }
        activeGeocodeRequest = request
        Task { @MainActor in
            // Stale-guarded by request identity (docs/best-practices.md §
            // "Generation counters for async state"): a newer search replaces
            // `activeGeocodeRequest`, so this one's writes are dropped.
            do {
                let items = try await request.mapItems
                guard activeGeocodeRequest === request else { return }
                activeGeocodeRequest = nil
                geocodeResults = items.map(GeocodeCandidate.init(mapItem:))
                isGeocoding = false
            } catch {
                guard activeGeocodeRequest === request else { return }
                activeGeocodeRequest = nil
                geocodeError = error.localizedDescription
                isGeocoding = false
            }
        }
        #else
        geocoder.cancelGeocode()
        geocoder.geocodeAddressString(q) { placemarks, error in
            Task { @MainActor in
                // A superseding search cancels this one — drop the stale
                // callback instead of clobbering the new search's spinner
                // and error state (the macOS twin of the identity guard on
                // the iOS branch above).
                if let clError = error as? CLError, clError.code == .geocodeCanceled { return }
                isGeocoding = false
                if let err = error {
                    geocodeError = err.localizedDescription
                } else {
                    geocodeResults = (placemarks ?? []).compactMap(GeocodeCandidate.init(placemark:))
                }
            }
        }
        #endif
    }

    private func applyCandidate(_ c: GeocodeCandidate) {
        vm.touchedMetadata.gpsLatitude  = c.latitude
        vm.touchedMetadata.gpsLongitude = c.longitude
        latText = String(format: "%.6f", c.latitude)
        lonText = String(format: "%.6f", c.longitude)
        if let alt = c.altitude {
            vm.touchedMetadata.gpsAltitude = alt
            altText = String(format: "%.1f", alt)
        }
        // Populate place-text fields from the candidate when available
        if let city    = c.city        { vm.touchedMetadata.city        = city    }
        if let state   = c.state       { vm.touchedMetadata.state       = state   }
        if let country = c.country     { vm.touchedMetadata.country     = country }
        if let code    = c.countryCode { vm.touchedMetadata.countryCode = code    }
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

// MARK: - GeocodeCandidate

/// One forward-geocode result, normalized across the platform fork in
/// `runGeocode()` — iOS resolves through MapKit's `MKGeocodingRequest`
/// (CLGeocoder is deprecated as of iOS 26, our iOS deployment target);
/// macOS (deployment target 14.0, where CLGeocoder is not yet deprecated)
/// stays on CLGeocoder until its target reaches 26. The picker and apply
/// path only ever see this type, so the UI stays shared.
private struct GeocodeCandidate: Hashable, Identifiable {
    let id = UUID()
    let label: String
    let latitude: Double
    let longitude: Double
    /// Meters; nil when the source didn't report a measured altitude. A
    /// positive `verticalAccuracy` on the source location means the altitude
    /// is measured; zero/negative means invalid — distinct from a genuine
    /// 0 m sea-level reading, which is valid and must be applied.
    let altitude: Double?
    let city: String?
    let state: String?
    let country: String?
    let countryCode: String?
}

#if os(iOS)
extension GeocodeCandidate {
    init(mapItem item: MKMapItem) {
        let reps = item.addressRepresentations
        let coordinate = item.location.coordinate
        let labelParts = [item.name, item.address?.fullAddress].compactMap { $0 }
        self.init(
            label: labelParts.isEmpty
                ? String(format: "%.4f, %.4f", coordinate.latitude, coordinate.longitude)
                : labelParts.joined(separator: ", "),
            latitude: coordinate.latitude,
            longitude: coordinate.longitude,
            altitude: item.location.verticalAccuracy > 0 ? item.location.altitude : nil,
            city: reps?.cityName,
            // MKAddressRepresentations exposes no discrete administrative-
            // area field (its `cityWithContext` appends state OR country,
            // locale-formatted — parsing it risks burning a country name
            // into the XMP State field across a whole batch). Leave state
            // for the user rather than guess; `applyCandidate` skips nil.
            state: nil,
            country: reps?.regionName,
            countryCode: reps?.region?.identifier
        )
    }
}
#else
extension GeocodeCandidate {
    /// Fails when the placemark has no resolved location (same guard the
    /// pre-fork `applyPlacemark` had).
    init?(placemark p: CLPlacemark) {
        guard let loc = p.location else { return nil }
        self.init(
            label: [p.name, p.locality, p.country].compactMap { $0 }.joined(separator: ", "),
            latitude: loc.coordinate.latitude,
            longitude: loc.coordinate.longitude,
            altitude: loc.verticalAccuracy > 0 ? loc.altitude : nil,
            city: p.locality,
            state: p.administrativeArea,
            country: p.country,
            countryCode: p.isoCountryCode
        )
    }
}
#endif

// MARK: - Preview

#Preview {
    BatchMetadataCaptureSection(
        vm: BatchMetadataViewModel(
            assets: [AssetRef(url: URL(fileURLWithPath: "/tmp/test.dng"))],
            sessions: [:]
        )
    )
}
