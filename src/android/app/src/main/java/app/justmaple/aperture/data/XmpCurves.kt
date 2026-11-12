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

/** A primary `rdf:Description` start tag, its source range and in-scope prefixes. */
internal class DescriptionTag(val range: IntRange, val text: String, val bindings: Map<String, String>) {
    val selfClosing: Boolean
        get() = text.endsWith("/>")
}

internal class XmlEdit(val start: Int, val end: Int, val text: String)

private const val RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
private const val WIRE_SCALE = 255f
private val TOKEN =
    Regex(
        """<!--.*?-->|<!\[CDATA\[.*?]]>|<\?.*?\?>|</([^\s>]+)\s*>|<([^\s/>!?]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(/?)>""",
        RegexOption.DOT_MATCHES_ALL,
    )
private val XMLNS = Regex("""\sxmlns:([^\s=]+)\s*=\s*(['"])(.*?)\2""")

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
                rdfDepth < 0 && parser.name == "RDF" && parser.namespace == RDF -> rdfDepth = parser.depth
                parser.depth == rdfDepth + 1 && parser.name == "Description" && parser.namespace == RDF -> {
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
                    val owned = if (parser.namespace == RDF) "rdf" else canonicalUri(parser.namespace)
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

/**
 * Removes the changed curves among every primary description's direct children
 * and writes their replacements into the last description. Identity is silence:
 * an empty curve writes no element. When the last description is self-closing,
 * the second value is the content and end tag that replace its `/>`.
 */
internal fun pointCurveEdits(
    xml: String,
    descriptions: List<DescriptionTag>,
    changes: Map<PointCurve, List<CurveKnot>>,
    canonicalName: (String, Map<String, String>) -> String,
    prefixes: Map<String, String>,
): Pair<List<XmlEdit>, String> {
    if (changes.isEmpty()) return emptyList<XmlEdit>() to ""
    val removals = descriptions.filterNot { it.selfClosing }.flatMap { description ->
        directChildren(xml, description.range.last + 1).mapNotNull { child ->
            val local = XMLNS.findAll(child.tag).associate { it.groupValues[1] to it.groupValues[3] }
            val curve = PointCurve.byElement[canonicalName(child.name, description.bindings + local)]
            if (curve !in changes) null
            else XmlEdit(whitespaceStart(xml, child.start, description.range.last + 1), child.end, "")
        }
    }
    val last = descriptions.last()
    val content = last.range.last + 1
    val close = if (last.selfClosing) null else directChildren(xml, content).closeStart
    val indent =
        (close?.takeIf { lineIndentEnd(xml, it) == it }?.let { lineIndent(xml, it) }
            ?: lineIndent(xml, last.range.first)) + "  "
    val rdf = last.bindings.entries.firstOrNull { it.value == RDF }?.key
    val block = buildString {
        for (curve in PointCurve.entries) {
            val knots = changes[curve]?.takeIf { it.isNotEmpty() } ?: continue
            val canonical = curve.element.substringBefore(':')
            val element = "${prefixes.getValue(canonical)}:${curve.element.substringAfter(':')}"
            val seq = if (rdf != null) "$rdf:Seq" else "rdf:Seq"
            val declare = if (rdf != null) "" else " xmlns:rdf=\"$RDF\""
            val li = if (rdf != null) "$rdf:li" else "rdf:li"
            append("\n$indent<$element>\n$indent  <$seq$declare>\n")
            for (knot in knots)
                append("$indent    <$li>${wire(knot.x)}, ${wire(knot.y)}</$li>\n")
            append("$indent  </$seq>\n$indent</$element>")
        }
    }
    val insertion =
        if (close == null || block.isEmpty()) emptyList()
        else whitespaceStart(xml, close, content).let { listOf(XmlEdit(it, it - 1, block)) }
    val tail =
        if (close != null || block.isEmpty()) ""
        else "$block\n${lineIndent(xml, last.range.first)}</${last.text.drop(1).takeWhile { !it.isWhitespace() && it != '/' && it != '>' }}>"
    return removals + insertion to tail
}

private fun wire(value: Float) = XmpDocument.format(value.coerceIn(0f, 1f) * WIRE_SCALE)

private class Child(val name: String, val tag: String, val start: Int, val end: Int)

private class Children(children: List<Child>, val closeStart: Int) : List<Child> by children

/** Direct children of the element whose content starts at [content], and its closing tag. */
private fun directChildren(xml: String, content: Int): Children {
    val children = mutableListOf<Child>()
    var depth = 1
    var open: MatchResult? = null
    for (token in TOKEN.findAll(xml, content)) {
        val (endName, startName, _, selfClose) = token.destructured
        when {
            endName.isNotEmpty() -> {
                depth -= 1
                if (depth == 0) return Children(children, token.range.first)
                if (depth == 1) open?.let {
                    children += Child(it.groupValues[2], it.value, it.range.first, token.range.last)
                    open = null
                }
            }
            startName.isNotEmpty() && selfClose.isEmpty() -> {
                if (depth == 1) open = token
                depth += 1
            }
            startName.isNotEmpty() && depth == 1 ->
                children += Child(startName, token.value, token.range.first, token.range.last)
        }
    }
    error("Unclosed RDF description")
}

private fun whitespaceStart(xml: String, index: Int, floor: Int): Int {
    var start = index
    while (start > floor && xml[start - 1].isWhitespace()) start -= 1
    return start
}

private fun lineIndent(xml: String, index: Int): String {
    val lineStart = xml.lastIndexOf('\n', index - 1) + 1
    return xml.substring(lineStart, lineIndentEnd(xml, lineStart))
}

private fun lineIndentEnd(xml: String, index: Int): Int {
    val lineStart = xml.lastIndexOf('\n', index - 1) + 1
    var end = lineStart
    while (end < xml.length && (xml[end] == ' ' || xml[end] == '\t')) end += 1
    return end
}
