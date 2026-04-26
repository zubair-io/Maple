// PanoramaSidecar.swift — `papp:Panorama` XMP schema read/write (T5.6).
//
// Namespace disambiguation
// ────────────────────────
// The `papp:` prefix is already used by Maple for flat scalar attributes:
//   • papp:HighlightRecoveryMode  (AdjustmentModel.swift)
//   • papp:Flag                   (CullingState / XMPSerializer)
//   • papp:ColorLabel             (CullingState / XMPSerializer)
//
// The panorama metadata is structurally richer than scalar attributes — it
// contains sequences, nested structs (Alignment, Output), and a per-source
// list. To avoid collision with the existing flat scalars we use a **nested
// element** form rather than flat attributes:
//
//   <papp:Panorama>
//     <papp:PanoSourceList> … </papp:PanoSourceList>
//     <papp:PanoAlignment>  … </papp:PanoAlignment>
//     <papp:PanoOutput>     … </papp:PanoOutput>
//     <papp:PanoPreset>Quality</papp:PanoPreset>
//   </papp:Panorama>
//
// The `papp:` URI is `http://ns.justmaple.app/1.0/` (identical to the one
// already registered in XMPSerializer / xmp-canonical-format.md).  No new
// namespace URI is needed — the nested element form is legal RDF/XML without
// requiring a separate namespace for sub-elements.
//
// XMP element structure
// ─────────────────────
// papp:Panorama (element child of rdf:Description)
//   papp:PanoSourceList (rdf:Seq)
//     rdf:li (rdf:Description)
//       papp:SourcePath     (string, absolute path)
//       papp:SourceBookmark (string, base64 bookmark, optional)
//       papp:SourceHash     (string, sha256 of original bytes)
//       papp:FocalLength    (number, mm)
//       papp:ExposureValue  (number, EV)
//   papp:PanoAlignment (rdf:Description)
//     papp:Homography     (rdf:Seq of 9 float strings, row-major 3×3)
//     papp:BAResidual     (number)
//   papp:PanoOutput (rdf:Description)
//     papp:OutputWidth      (uint32)
//     papp:OutputHeight     (uint32)
//     papp:OutputProjection (string: rectilinear | cylindrical | spherical)
//   papp:PanoPreset (string: Quick | Quality)
//
// Round-trip contract
// ────────────────────
// serialize(PanoramaSidecar) → XML → parse(XML) → PanoramaSidecar must be
// struct-equal. The test in PappSchemaTests.swift verifies this byte-for-byte
// using the same XMP envelope rules as xmp-canonical-format.md.

import Foundation

// MARK: - PanoramaSidecar

/// Swift model of the `papp:Panorama` XMP schema (spec § 12 Open Q#8).
///
/// Construct from source images after a successful stitch; write with
/// `PanoramaXMPSerializer.serialize(_:)` and read back with
/// `PanoramaXMPParser.parse(_:)`.
public struct PanoramaSidecar: Sendable, Equatable {

    /// Per-source-image metadata (one entry per input image).
    public struct SourceEntry: Sendable, Equatable {
        /// Absolute filesystem path to the source image.
        public var sourcePath: String
        /// Security-scoped bookmark, base64-encoded. `nil` if not needed or not yet resolved.
        public var sourceBookmark: String?
        /// SHA-256 hex digest of the source image bytes at the time of stitching.
        public var sourceHash: String
        /// Focal length in millimetres (as reported by EXIF, or 0 if unknown).
        public var focalLength: Double
        /// Exposure value (as reported by EXIF, or 0 if unknown).
        public var exposureValue: Double

        public init(
            sourcePath: String,
            sourceBookmark: String? = nil,
            sourceHash: String,
            focalLength: Double,
            exposureValue: Double
        ) {
            self.sourcePath = sourcePath
            self.sourceBookmark = sourceBookmark
            self.sourceHash = sourceHash
            self.focalLength = focalLength
            self.exposureValue = exposureValue
        }
    }

    /// Alignment / bundle-adjustment result for this panorama.
    public struct Alignment: Sendable, Equatable {
        /// 3×3 homography matrix, row-major (9 elements).
        /// Identity when not computed yet: [ 1, 0, 0, 0, 1, 0, 0, 0, 1 ].
        public var homography: [Double]
        /// Mean bundle-adjustment reprojection residual in pixels. 0 when not computed.
        public var baResidual: Double

        public static let identity = Alignment(
            homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            baResidual: 0
        )

        public init(homography: [Double], baResidual: Double) {
            self.homography = homography
            self.baResidual = baResidual
        }
    }

    /// Output geometry and projection.
    public struct Output: Sendable, Equatable {
        public var width: UInt32
        public var height: UInt32
        public var projection: Projection

        public enum Projection: String, Sendable, Equatable, CaseIterable {
            case rectilinear
            case cylindrical
            case spherical
        }

        public init(width: UInt32, height: UInt32, projection: Projection) {
            self.width = width
            self.height = height
            self.projection = projection
        }
    }

    /// Stitching quality preset.
    public enum Preset: String, Sendable, Equatable, CaseIterable {
        /// Vision + Metal + vImage fast path (JPEG/HEIF inputs, Apple only).
        case quick = "Quick"
        /// Rust pano-core path (DNG default, cross-platform, parity-gated).
        case quality = "Quality"
    }

    public var sources: [SourceEntry]
    public var alignment: Alignment
    public var output: Output
    public var preset: Preset

    public init(
        sources: [SourceEntry],
        alignment: Alignment,
        output: Output,
        preset: Preset
    ) {
        self.sources = sources
        self.alignment = alignment
        self.output = output
        self.preset = preset
    }
}

// MARK: - PanoramaXMPSerializer

/// Serializes a `PanoramaSidecar` into the `papp:Panorama` XMP element string
/// fragment (without the full XMP envelope — callers embed this inside a
/// `rdf:Description`).
public struct PanoramaXMPSerializer {
    private init() {}

    /// Return the full XMP document string for a panorama sidecar.
    ///
    /// The document follows the same envelope layout as `XMPSerializer.serialize`
    /// and is parseable by `PanoramaXMPParser.parse`.
    public static func serialize(_ pano: PanoramaSidecar) -> String {
        let indent2 = "  "
        let indent4 = "    "
        let indent6 = "      "
        let indent8 = "        "
        let indent10 = "          "
        let indent12 = "            "

        var lines: [String] = []
        lines.append("<?xpacket begin=\"\u{FEFF}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>")
        lines.append("<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">")
        lines.append("\(indent2)<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">")
        lines.append("\(indent4)<rdf:Description")
        lines.append("\(indent6)xmlns:papp=\"http://ns.justmaple.app/1.0/\">")

        // --- papp:Panorama element ---
        lines.append("\(indent6)<papp:Panorama>")

        // papp:PanoSourceList
        lines.append("\(indent8)<papp:PanoSourceList>")
        lines.append("\(indent10)<rdf:Seq>")
        for entry in pano.sources {
            lines.append("\(indent12)<rdf:li rdf:parseType=\"Resource\">")
            lines.append("\(indent12)  <papp:SourcePath>\(xmlEscape(entry.sourcePath))</papp:SourcePath>")
            if let bm = entry.sourceBookmark {
                lines.append("\(indent12)  <papp:SourceBookmark>\(xmlEscape(bm))</papp:SourceBookmark>")
            }
            lines.append("\(indent12)  <papp:SourceHash>\(xmlEscape(entry.sourceHash))</papp:SourceHash>")
            lines.append("\(indent12)  <papp:FocalLength>\(fmtNum(entry.focalLength))</papp:FocalLength>")
            lines.append("\(indent12)  <papp:ExposureValue>\(fmtNum(entry.exposureValue))</papp:ExposureValue>")
            lines.append("\(indent12)</rdf:li>")
        }
        lines.append("\(indent10)</rdf:Seq>")
        lines.append("\(indent8)</papp:PanoSourceList>")

        // papp:PanoAlignment
        lines.append("\(indent8)<papp:PanoAlignment rdf:parseType=\"Resource\">")
        lines.append("\(indent10)<papp:Homography>")
        lines.append("\(indent12)<rdf:Seq>")
        for val in pano.alignment.homography {
            lines.append("\(indent12)  <rdf:li>\(fmtNum(val))</rdf:li>")
        }
        lines.append("\(indent12)</rdf:Seq>")
        lines.append("\(indent10)</papp:Homography>")
        lines.append("\(indent10)<papp:BAResidual>\(fmtNum(pano.alignment.baResidual))</papp:BAResidual>")
        lines.append("\(indent8)</papp:PanoAlignment>")

        // papp:PanoOutput
        lines.append("\(indent8)<papp:PanoOutput rdf:parseType=\"Resource\">")
        lines.append("\(indent10)<papp:OutputWidth>\(pano.output.width)</papp:OutputWidth>")
        lines.append("\(indent10)<papp:OutputHeight>\(pano.output.height)</papp:OutputHeight>")
        lines.append("\(indent10)<papp:OutputProjection>\(pano.output.projection.rawValue)</papp:OutputProjection>")
        lines.append("\(indent8)</papp:PanoOutput>")

        // papp:PanoPreset
        lines.append("\(indent8)<papp:PanoPreset>\(pano.preset.rawValue)</papp:PanoPreset>")

        lines.append("\(indent6)</papp:Panorama>")
        lines.append("\(indent4)</rdf:Description>")
        lines.append("\(indent2)</rdf:RDF>")
        lines.append("</x:xmpmeta>")
        lines.append("<?xpacket end=\"w\"?>")
        return lines.joined(separator: "\n")
    }

    // MARK: Private helpers

    /// Number formatter: integer when whole, 2-decimal otherwise (trailing
    /// zeros stripped), matching the xmp-canonical-format.md contract.
    static func fmtNum(_ v: Double) -> String {
        if v == v.rounded() && !v.isInfinite {
            return String(format: "%.0f", v)
        }
        var s = String(format: "%.2f", v)
        // Strip trailing zeros after the decimal
        if s.contains(".") {
            while s.hasSuffix("0") { s.removeLast() }
            if s.hasSuffix(".") { s.removeLast() }
        }
        return s
    }

    static func xmlEscape(_ s: String) -> String {
        s
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }
}

// MARK: - PanoramaXMPParser

/// Parses the `papp:Panorama` XMP element from a full XMP document string
/// produced by `PanoramaXMPSerializer.serialize`.
///
/// The parser is tolerant of unknown elements (passthrough) but requires the
/// exact element hierarchy produced by the serializer for round-trip fidelity.
public struct PanoramaXMPParser {
    private init() {}

    public enum ParseError: Error, LocalizedError {
        case notUTF8
        case xmlError(String)
        case missingPanorama
        case invalidHomographyCount(Int)

        public var errorDescription: String? {
            switch self {
            case .notUTF8:                   return "Panorama XMP is not valid UTF-8"
            case .xmlError(let m):           return "Panorama XMP parse error: \(m)"
            case .missingPanorama:           return "No papp:Panorama element found"
            case .invalidHomographyCount(let n):
                return "papp:Homography must have 9 elements, got \(n)"
            }
        }
    }

    /// Parse a full XMP document and return the embedded `PanoramaSidecar`.
    public static func parse(data: Data) throws -> PanoramaSidecar {
        guard let xml = String(data: data, encoding: .utf8) else {
            throw ParseError.notUTF8
        }
        return try parse(xml)
    }

    public static func parse(_ xml: String) throws -> PanoramaSidecar {
        let delegate = _PanoXMLDelegate()
        let parser = XMLParser(data: Data(xml.utf8))
        parser.delegate = delegate
        guard parser.parse() else {
            let msg = parser.parserError?.localizedDescription ?? "unknown"
            throw ParseError.xmlError(msg)
        }
        if delegate.parseError != nil {
            throw delegate.parseError!
        }
        guard let pano = delegate.result else {
            throw ParseError.missingPanorama
        }
        return pano
    }
}

// MARK: - XML Parser delegate (private)

private final class _PanoXMLDelegate: NSObject, XMLParserDelegate {
    // State machine
    private enum State {
        case idle
        case inPanorama
        case inSourceList, inSourceSeq, inSourceLi
        case inAlignment
        case inHomography, inHomographySeq, inHomographyLi
        case inOutput
        case done
    }

    private var state: State = .idle
    private var currentText = ""

    // Accumulated values
    private var sources: [PanoramaSidecar.SourceEntry] = []
    private var currentSourcePath = ""
    private var currentSourceBookmark: String? = nil
    private var currentSourceHash = ""
    private var currentFocalLength = 0.0
    private var currentEV = 0.0

    private var homographyValues: [Double] = []
    private var baResidual = 0.0

    private var outputWidth: UInt32 = 0
    private var outputHeight: UInt32 = 0
    private var outputProjection: PanoramaSidecar.Output.Projection = .cylindrical

    private var preset: PanoramaSidecar.Preset = .quality

    var result: PanoramaSidecar? = nil
    var parseError: PanoramaXMPParser.ParseError? = nil

    // Element stack to track nesting
    private var elementStack: [String] = []

    func parser(_ parser: XMLParser,
                didStartElement elementName: String,
                namespaceURI: String?,
                qualifiedName qName: String?,
                attributes attributeDict: [String: String]) {
        let name = qName ?? elementName
        elementStack.append(name)
        currentText = ""

        switch name {
        case "papp:Panorama":
            state = .inPanorama
        case "papp:PanoSourceList" where state == .inPanorama:
            state = .inSourceList
        case "rdf:Seq" where state == .inSourceList:
            state = .inSourceSeq
        case "rdf:li" where state == .inSourceSeq:
            state = .inSourceLi
            // Reset per-source accumulator
            currentSourcePath = ""
            currentSourceBookmark = nil
            currentSourceHash = ""
            currentFocalLength = 0
            currentEV = 0
        case "papp:PanoAlignment" where state == .inPanorama:
            state = .inAlignment
        case "papp:Homography" where state == .inAlignment:
            state = .inHomography
        case "rdf:Seq" where state == .inHomography:
            state = .inHomographySeq
        case "rdf:li" where state == .inHomographySeq:
            state = .inHomographyLi
        case "papp:PanoOutput" where state == .inPanorama:
            state = .inOutput
        default:
            break
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        currentText += string
    }

    func parser(_ parser: XMLParser,
                didEndElement elementName: String,
                namespaceURI: String?,
                qualifiedName qName: String?) {
        let name = qName ?? elementName
        let text = currentText.trimmingCharacters(in: .whitespacesAndNewlines)
        _ = elementStack.popLast()

        switch name {
        // --- source list ---
        case "papp:SourcePath"     where state == .inSourceLi: currentSourcePath = text
        case "papp:SourceBookmark" where state == .inSourceLi: currentSourceBookmark = text.isEmpty ? nil : text
        case "papp:SourceHash"     where state == .inSourceLi: currentSourceHash = text
        case "papp:FocalLength"    where state == .inSourceLi: currentFocalLength = Double(text) ?? 0
        case "papp:ExposureValue"  where state == .inSourceLi: currentEV = Double(text) ?? 0

        case "rdf:li" where state == .inSourceLi:
            sources.append(PanoramaSidecar.SourceEntry(
                sourcePath: currentSourcePath,
                sourceBookmark: currentSourceBookmark,
                sourceHash: currentSourceHash,
                focalLength: currentFocalLength,
                exposureValue: currentEV
            ))
            state = .inSourceSeq

        case "rdf:Seq" where state == .inSourceSeq:  state = .inSourceList
        case "papp:PanoSourceList":                   state = .inPanorama

        // --- alignment ---
        case "rdf:li" where state == .inHomographyLi:
            homographyValues.append(Double(text) ?? 0)
            state = .inHomographySeq
        case "rdf:Seq" where state == .inHomographySeq: state = .inHomography
        case "papp:Homography":                          state = .inAlignment
        case "papp:BAResidual" where state == .inAlignment: baResidual = Double(text) ?? 0
        case "papp:PanoAlignment":                       state = .inPanorama

        // --- output ---
        case "papp:OutputWidth"      where state == .inOutput:
            outputWidth = UInt32(text) ?? 0
        case "papp:OutputHeight"     where state == .inOutput:
            outputHeight = UInt32(text) ?? 0
        case "papp:OutputProjection" where state == .inOutput:
            outputProjection = PanoramaSidecar.Output.Projection(rawValue: text) ?? .cylindrical
        case "papp:PanoOutput": state = .inPanorama

        // --- preset ---
        case "papp:PanoPreset" where state == .inPanorama:
            preset = PanoramaSidecar.Preset(rawValue: text) ?? .quality

        // --- top-level panorama close ---
        case "papp:Panorama":
            if homographyValues.count != 9 && !homographyValues.isEmpty {
                parseError = .invalidHomographyCount(homographyValues.count)
                parser.abortParsing()
                return
            }
            let hom = homographyValues.isEmpty
                ? [1.0, 0, 0, 0, 1, 0, 0, 0, 1]
                : homographyValues
            result = PanoramaSidecar(
                sources: sources,
                alignment: PanoramaSidecar.Alignment(homography: hom, baResidual: baResidual),
                output: PanoramaSidecar.Output(
                    width: outputWidth,
                    height: outputHeight,
                    projection: outputProjection
                ),
                preset: preset
            )
            state = .done

        default:
            break
        }

        currentText = ""
    }
}
