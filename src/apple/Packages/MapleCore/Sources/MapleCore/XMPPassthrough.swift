// XMPPassthrough.swift — the unknown-attribute / unknown-nested-node bucket
// for the Apple sidecar layer (#2233).
//
// Every field Maple does not model used to vanish on the first Apple save:
// `XMPParser.parse` returned `(AdjustmentModel, CullingState)` and
// `XMPSerializer` rebuilt the document from those two values alone, so a
// Lightroom sidecar lost its mask groups, history, snapshots and
// `crs:ToneCurvePV2012*` curves the moment a slider moved. This type is the
// Swift half of the passthrough contract the TypeScript layer has had since
// P6 (`PassthroughBucket` in `xmp.types.ts`), and
// `docs/xmp-canonical-format.md` § "Passthrough" is the prose spec both
// implement.
//
// Semantics mirror the web deliberately:
//   • unknown attributes on `rdf:Description` re-emit through the canonical
//     attribute sort, where the unknown-namespace priority puts them after
//     every known one;
//   • unknown nested elements re-emit verbatim, in original document order,
//     because masks / history / snapshots are ordered stacks.
//
// One deliberate widening over the web parser: foreign `xmlns:` declarations
// on `rdf:Description` ride the attribute bucket too. The web parser drops
// them (`!attr.name.startsWith('xmlns')`), which is fine only while every
// preserved node lives in a namespace the canonical prelude already declares.
// A real Lightroom sidecar's `<xmpMM:History>` does not, and re-emitting that
// subtree without its declaration produces a document a namespace-aware
// reader rejects — so the preserved bytes would not actually survive. The
// prefixes the canonical writer emits itself are excluded so the output can
// never carry a duplicate declaration.

import Foundation

/// Attributes and nested elements from a source sidecar that Maple does not
/// model, captured on parse so they can be re-emitted verbatim on save.
///
/// Mirrors the TypeScript `PassthroughBucket`. The node payload is the child
/// element's source text, not a decoded tree: attribute order inside a foreign
/// subtree carries no meaning to Maple but IS part of the bytes the author
/// wrote, and Swift's `XMLParser` hands attributes back in an unordered
/// dictionary — re-serializing from parse events would reshuffle a mask stack
/// on every save.
public struct XMPPassthrough: Sendable, Equatable {
    /// One unknown `name="value"` pair from `rdf:Description`. `value` is the
    /// *decoded* text (entities already resolved); the serializer re-escapes
    /// it, exactly as the web serializer does.
    public struct Attribute: Sendable, Equatable {
        public let name: String
        public let value: String

        public init(name: String, value: String) {
            self.name = name
            self.value = value
        }
    }

    /// Unknown attributes on `rdf:Description`, in source order. The canonical
    /// attribute sort reorders them on write, so this order is informational.
    public var unknownAttributes: [Attribute]

    /// Verbatim source text of unknown child elements of `rdf:Description`,
    /// in document order.
    public var unknownNodes: [String]

    public static let empty = XMPPassthrough(unknownAttributes: [], unknownNodes: [])

    public var isEmpty: Bool { unknownAttributes.isEmpty && unknownNodes.isEmpty }

    public init(unknownAttributes: [Attribute] = [], unknownNodes: [String] = []) {
        self.unknownAttributes = unknownAttributes
        self.unknownNodes = unknownNodes
    }
}

// MARK: - The known set

/// The attribute names and child elements Maple itself owns. Anything on
/// `rdf:Description` outside these sets is passthrough.
///
/// This is a hand-maintained mirror of the `applyAttribute` switch in
/// `XMPSerialization+ParseAttrs.swift` (plus the HSL / black-white helpers and
/// the metadata block). A name missing here would be emitted twice — once from
/// the model, once from the passthrough pipe — so
/// `XMPPassthroughTests.testEverySerializedAttributeIsKnown` asserts the
/// serializer's own output is a subset of `attributes`.
enum XMPKnownFields {
    /// Structural attributes the canonical writer authors itself.
    private static let structural: Set<String> = [
        "rdf:about", "crs:Version", "crs:ProcessVersion", "crs:HasSettings",
    ]

    /// Scene-linear develop sliders + the WB group.
    private static let develop: Set<String> = [
        "crs:WhiteBalance", "crs:Temperature", "crs:Tint", "papp:WbScaleVersion",
        "crs:Exposure2012", "papp:Brightness", "crs:Contrast2012",
        "crs:Highlights2012", "crs:Shadows2012", "crs:Whites2012", "crs:Blacks2012",
        "crs:ParametricHighlights", "crs:ParametricLights",
        "crs:ParametricDarks", "crs:ParametricShadows",
        "crs:Vibrance", "crs:Saturation", "crs:Clarity2012", "crs:Texture", "crs:Dehaze",
        "crs:Sharpness", "crs:SharpenRadius", "crs:SharpenDetail", "crs:SharpenEdgeMasking",
        "papp:CaptureSharpeningAmount", "papp:CaptureSharpeningSigma",
        // Read-only legacy alias (#456) — parsed into `captureSharpeningSigma`
        // and never written, so it must not fall through to passthrough or a
        // re-save would carry both spellings.
        "papp:CaptureSharpeningRadius",
        "crs:LuminanceSmoothing", "crs:ColorNoiseReduction",
        "papp:ChromaPrefilter", "papp:DeepDenoise", "papp:HotPixelSuppression",
        "papp:HighlightRecoveryMode", "papp:AutoExposure", "papp:Look", "papp:Profile",
        "crs:PostCropVignetteAmount", "crs:PostCropVignetteFeather",
        "crs:GrainAmount", "crs:GrainSize", "crs:GrainFrequency",
        "crs:SplitToningShadowHue", "crs:SplitToningShadowSaturation",
        "crs:SplitToningHighlightHue", "crs:SplitToningHighlightSaturation",
        "crs:SplitToningBalance",
        "crs:ColorGradeShadowLum", "crs:ColorGradeMidtoneHue", "crs:ColorGradeMidtoneSat",
        "crs:ColorGradeMidtoneLum", "crs:ColorGradeHighlightLum",
        "crs:ColorGradeGlobalHue", "crs:ColorGradeGlobalSat", "crs:ColorGradeGlobalLum",
        "crs:LensProfileEnable", "crs:LensProfileDistortionScale",
        "crs:LensProfileChromaticAberrationScale", "crs:LensProfileVignettingScale",
        "crs:HasCrop", "crs:CropTop", "crs:CropLeft", "crs:CropBottom", "crs:CropRight",
        "crs:CropAngle", "crs:CropConstrainToWarp",
    ]

    /// The 24 HSL bands + the black-and-white toggle and its 8 mixer weights.
    private static let bands: Set<String> = {
        let hues = ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"]
        let hsl = ["HueAdjustment", "SaturationAdjustment", "LuminanceAdjustment", "GrayMixer"]
            .flatMap { stem in hues.map { "crs:\(stem)\($0)" } }
        return Set(hsl + ["crs:ConvertToGrayscale"])
    }()

    /// Rating / flag / colour label / hidden, including the read-only
    /// `xmp:Label` legacy flag alias (#2221) the serializer never writes back.
    private static let culling: Set<String> = [
        "xmp:Rating", "papp:Flag", "xmp:Label", "papp:ColorLabel", "papp:Hidden",
    ]

    /// The IPTC/EXIF batch-metadata attributes (`XMPSerialization+Metadata.swift`).
    private static let metadata: Set<String> = [
        "exif:GPSLatitude", "exif:GPSLongitude", "exif:GPSAltitude", "exif:GPSAltitudeRef",
        "exif:DateTimeOriginal", "papp:TimeZone",
        "Iptc4xmpCore:Location", "Iptc4xmpCore:CountryCode",
        "photoshop:City", "photoshop:State", "photoshop:Country",
        "photoshop:Headline", "photoshop:Instructions", "photoshop:AuthorsPosition",
        "photoshop:Credit", "photoshop:Source",
        "xmpRights:Marked",
    ]

    /// Every attribute name on `rdf:Description` that Maple reads into its own
    /// model or authors itself.
    static let attributes: Set<String> =
        structural.union(develop).union(bands).union(culling).union(metadata)

    /// Namespace prefixes the canonical envelope declares itself — on
    /// `rdf:Description` (the three core plus the conditional metadata ones)
    /// or on an ancestor (`x:xmpmeta`, `rdf:RDF`). A source declaration for
    /// one of these is dropped rather than preserved: re-emitting it would put
    /// a duplicate `xmlns:` on the same start tag, which is not well-formed.
    static let selfDeclaredNamespacePrefixes: Set<String> = [
        "xmp", "crs", "papp",
        "dc", "exif", "photoshop", "Iptc4xmpCore", "xmpRights",
        "rdf", "x",
    ]

    /// Child elements of `rdf:Description` the serializer emits from the model
    /// — the keyword bag, the four point tone curves, and the metadata
    /// lang-alt / seq blocks. Leaving any of these in the node bucket would
    /// double-emit it.
    static let managedChildElements: Set<String> = Set(
        ToneCurveXMP.elements + [
            "dc:subject",
            "dc:title", "dc:creator", "dc:description", "dc:rights",
            "xmpRights:UsageTerms",
        ])

    /// True when `qName` names a child the serializer re-emits from the model.
    ///
    /// `dc:subject` also matches prefix-agnostically because the keyword walk
    /// in `_XMPParserDelegate` does — a sidecar binding Dublin Core to another
    /// prefix still parses its keywords, so its bag must not also survive as a
    /// passthrough node.
    static func isManagedChild(_ qName: String) -> Bool {
        managedChildElements.contains(qName)
            || qName == "subject" || qName.hasSuffix(":subject")
    }

    /// True when `name` is an attribute the passthrough bucket must ignore:
    /// either a field Maple models, or a namespace declaration the canonical
    /// writer emits itself.
    static func isKnownAttribute(_ name: String) -> Bool {
        if attributes.contains(name) { return true }
        // A default-namespace declaration on `rdf:Description` would change
        // how every unprefixed name in the document resolves; the canonical
        // envelope owns that decision, so it is dropped rather than preserved.
        if name == "xmlns" { return true }
        guard name.hasPrefix("xmlns:") else { return false }
        return selfDeclaredNamespacePrefixes.contains(String(name.dropFirst("xmlns:".count)))
    }
}
