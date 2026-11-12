package app.justmaple.aperture.data

import android.util.Xml
import java.io.StringReader
import org.xmlpull.v1.XmlPullParser

/** One authored knot in the `[0, 1]` authoring domain. */
data class CurveKnot(val x: Float, val y: Float)

/**
 * The knot curves in canonical emit order: the eight point tone curves, Maple's
 * scene-linear family (`papp:`) and the display-referred `crs:ToneCurvePV2012`
 * family (`docs/xmp-canonical-format.md` § "Tone curves"), then the six Oklab
 * colour curves, which share the same `rdf:Seq` wire form. Android edits only the
 * tone curves; the colour curves travel with Copy / Paste settings.
 */
enum class PointCurve(val element: String) {
    SceneLuma("papp:SceneLinearToneCurve"),
    SceneRed("papp:SceneLinearToneCurveRed"),
    SceneGreen("papp:SceneLinearToneCurveGreen"),
    SceneBlue("papp:SceneLinearToneCurveBlue"),
    DisplayLuma("crs:ToneCurvePV2012"),
    DisplayRed("crs:ToneCurvePV2012Red"),
    DisplayGreen("crs:ToneCurvePV2012Green"),
    DisplayBlue("crs:ToneCurvePV2012Blue"),
    HueVsHue("papp:ColorCurveHueVsHue"),
    HueVsSat("papp:ColorCurveHueVsSat"),
    HueVsLuma("papp:ColorCurveHueVsLuma"),
    LumaVsSat("papp:ColorCurveLumaVsSat"),
    SatVsSat("papp:ColorCurveSatVsSat"),
    SatVsLuma("papp:ColorCurveSatVsLuma");

    companion object {
        val byElement = entries.associateBy { it.element }
    }
}

private const val WIRE_SCALE = 255f

/**
 * Curves of the primary subject's descriptions' direct children ([primary] flags each
 * top-level description in order); nested look curves are not edits. Inside a curve only
 * `rdf:`/`crs:`/`papp:` elements count, as in raw-core's import: a foreign or workflow
 * element is opaque with everything it contains, so its leaves are never knots.
 */
internal fun readPointCurves(
    xml: String,
    canonicalUri: (String?) -> String?,
    primary: List<Boolean>,
): Map<PointCurve, List<CurveKnot>> {
    val parser = Xml.newPullParser()
    parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true)
    parser.setInput(StringReader(xml.removePrefix("\uFEFF")))
    val curves = mutableMapOf<PointCurve, List<CurveKnot>>()
    var rdfDepth = -1
    var descriptions = 0
    var descriptionDepth = -1
    var active: PointCurve? = null
    var activeDepth = -1
    var opaqueDepth = -1
    val knots = mutableListOf<CurveKnot>()
    val text = StringBuilder()
    var inLeaf = false
    while (parser.next() != XmlPullParser.END_DOCUMENT) {
        when (parser.eventType) {
            XmlPullParser.START_TAG -> when {
                rdfDepth < 0 && parser.name == "RDF" && parser.namespace == RDF_NAMESPACE -> rdfDepth = parser.depth
                parser.depth == rdfDepth + 1 && parser.name == "Description" && parser.namespace == RDF_NAMESPACE -> {
                    if (primary.getOrElse(descriptions) { false }) descriptionDepth = parser.depth
                    descriptions += 1
                }
                descriptionDepth > 0 && parser.depth == descriptionDepth + 1 -> {
                    active = canonicalUri(parser.namespace)?.let { PointCurve.byElement["$it:${parser.name}"] }
                    activeDepth = parser.depth
                    opaqueDepth = -1
                    knots.clear()
                }
                active != null && opaqueDepth < 0 -> {
                    val owned = if (parser.namespace == RDF_NAMESPACE) "rdf" else canonicalUri(parser.namespace)
                    when {
                        owned != "rdf" && owned != "crs" && owned != "papp" -> opaqueDepth = parser.depth
                        owned == "papp" && parser.name == "Workflow" -> opaqueDepth = parser.depth
                        parser.name == "li" -> {
                            inLeaf = true
                            text.setLength(0)
                        }
                    }
                }
            }
            XmlPullParser.TEXT -> if (inLeaf) text.append(parser.text)
            XmlPullParser.END_TAG -> when {
                parser.depth == opaqueDepth -> opaqueDepth = -1
                opaqueDepth >= 0 -> {}
                inLeaf && parser.name == "li" -> {
                    inLeaf = false
                    parseKnot(text.toString())?.let(knots::add)
                }
                active != null && parser.depth == activeDepth -> {
                    curves[active] = knots.toList()
                    active = null
                }
                parser.depth == descriptionDepth -> descriptionDepth = -1
                parser.depth == rdfDepth -> rdfDepth = Int.MAX_VALUE
            }
        }
    }
    return curves
}

/** A malformed leaf is dropped, as raw-core's reader drops it. */
private fun parseKnot(text: String): CurveKnot? {
    val comma = text.indexOf(',')
    if (comma < 0) return null
    val x = text.substring(0, comma).trim().toFloatOrNull() ?: return null
    val y = text.substring(comma + 1).trim().toFloatOrNull() ?: return null
    return if (x.isFinite() && y.isFinite()) CurveKnot(x / WIRE_SCALE, y / WIRE_SCALE) else null
}

/** Removes the changed curves among every primary description's direct children. */
internal fun pointCurveRemovals(
    xml: String,
    descriptions: List<DescriptionTag>,
    changes: Map<PointCurve, List<CurveKnot>>,
    canonicalName: (String, Map<String, String>) -> String,
): List<XmlEdit> =
    if (changes.isEmpty()) emptyList()
    else matchingChildren(xml, descriptions, canonicalName) { PointCurve.byElement[it] in changes }
        .map { (child, description) -> removal(xml, child, description) }

/**
 * The replacements for changed curves, one line-leading element each, written at
 * [indent] in the last description. Identity is silence: an empty curve writes no element.
 */
internal fun pointCurveBlock(
    changes: Map<PointCurve, List<CurveKnot>>,
    last: DescriptionTag,
    prefixes: Map<String, String>,
    indent: String,
): String {
    val rdf = last.bindings.entries.firstOrNull { it.value == RDF_NAMESPACE }?.key
    return buildString {
        for (curve in PointCurve.entries) {
            val knots = changes[curve]?.takeIf { it.isNotEmpty() } ?: continue
            val canonical = curve.element.substringBefore(':')
            val element = "${prefixes.getValue(canonical)}:${curve.element.substringAfter(':')}"
            val seq = if (rdf != null) "$rdf:Seq" else "rdf:Seq"
            val declare = if (rdf != null) "" else " xmlns:rdf=\"$RDF_NAMESPACE\""
            val li = if (rdf != null) "$rdf:li" else "rdf:li"
            append("\n$indent<$element>\n$indent  <$seq$declare>\n")
            for (knot in knots)
                append("$indent    <$li>${wire(knot.x)}, ${wire(knot.y)}</$li>\n")
            append("$indent  </$seq>\n$indent</$element>")
        }
    }
}

private fun wire(value: Float) = XmpDocument.format(value.coerceIn(0f, 1f) * WIRE_SCALE)
