package app.justmaple.aperture.data

import android.util.Xml
import app.justmaple.aperture.generated.AdjustmentField
import app.justmaple.aperture.generated.AdjustmentFields
import app.justmaple.aperture.generated.XmpSubject
import java.io.StringReader
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject
import org.xmlpull.v1.XmlPullParser

/** A lexical patch preserves all unedited XML bytes, including foreign data. */
class XmpDocument
private constructor(
    private val source: ParsedSource,
    val changes: Map<String, String?>,
    /** Point curves replaced since [original]; an empty list is the identity. */
    val curves: Map<PointCurve, List<CurveKnot>>,
    /** The mask containers rewritten since [original]; `null` keeps their bytes. */
    val masks: MaskEdit?,
) {
    constructor(
        original: String = EMPTY,
        changes: Map<String, String?> = emptyMap(),
        curves: Map<PointCurve, List<CurveKnot>> = emptyMap(),
    ) : this(ParsedSource(original), changes, curves, null)

    val original: String
        get() = source.xml

    // Scalar revisions share the immutable parse, including across undo/redo.
    private class ParsedSource(val xml: String) {
        private val scopes = validate(xml).let { descriptions(xml) }
        val tags =
            scopes.filter { it.second.primary }.also {
                require(it.isNotEmpty()) { "XMP has no RDF description" }
            }
        val attributes = buildMap { tags.forEach { putAll(it.second.attributes) } }
        val curves by lazy {
            readPointCurves(xml, ::canonicalPrefix, scopes.filter { it.second.topLevel }.map { it.second.primary })
        }
        val descriptionTags by lazy {
            tags.map { (tag, scope) -> DescriptionTag(tag.range, tag.value, effectiveBindings(tag.value, scope.bindings)) }
        }
        val maskContainers by lazy {
            matchingChildren(xml, descriptionTags, ::attributeName) { it in MASK_CONTAINERS }
        }
    }

    override fun equals(other: Any?): Boolean =
        this === other ||
            (other is XmpDocument && original == other.original && changes == other.changes &&
                curves == other.curves && masks == other.masks)

    override fun hashCode(): Int =
        31 * (31 * (31 * original.hashCode() + changes.hashCode()) + curves.hashCode()) + masks.hashCode()

    fun curve(curve: PointCurve): List<CurveKnot> = curves[curve] ?: source.curves[curve].orEmpty()

    private fun originalMask(index: Int): String =
        source.maskContainers[index].first.let { original.substring(it.start, it.end + 1) }

    /** The mask containers as they stand, each with the scope it is read in. */
    private fun currentMasks(): List<Pair<Int?, JSONObject>> {
        val last = source.descriptionTags.last()
        val target = maskTarget(last)
        val kept = source.maskContainers.indices.mapNotNull { index ->
            val text = masks?.containers?.get(index) ?: originalMask(index)
            val scope = source.maskContainers[index].second.bindings
            text.takeIf { it.isNotEmpty() }?.let { index to maskSource(scope, it) }
        }
        return kept + masks?.appended.orEmpty().map { null to maskSource(target, it) }
    }

    /** `mask_document.rs`'s input for the current mask containers. */
    fun maskInput(): JSONObject {
        val last = source.descriptionTags.last()
        return JSONObject()
            .put("target", JSONObject(maskTarget(last).toMap()))
            .put("containers", JSONArray(currentMasks().map { it.second }))
            .put("legacy", attribute(LEGACY_MASKS) ?: JSONObject.NULL)
            .put("indent", childIndent(original, last))
    }

    /** The document after `mask_write.rs` replaced the containers [maskInput] described. */
    fun withMaskOutput(output: JSONObject): XmpDocument {
        val replaced = output.getJSONArray("containers")
        val written = output.getJSONArray("appended")
        val containers = source.maskContainers.indices.map { masks?.containers?.get(it) ?: originalMask(it) }.toMutableList()
        val appended = mutableListOf<String>()
        currentMasks().forEachIndexed { position, (index, _) ->
            val text = replaced.getString(position)
            if (index != null) containers[index] = text else if (text.isNotEmpty()) appended += text
        }
        for (position in 0 until written.length()) appended += written.getString(position)
        val unchanged = appended.isEmpty() && containers.indices.all { containers[it] == originalMask(it) }
        val withoutLegacy = if (attribute(LEGACY_MASKS) != null) changes + (LEGACY_MASKS to null) else changes
        return XmpDocument(source, withoutLegacy, curves, if (unchanged) null else MaskEdit(containers, appended))
    }

    private fun maskTarget(last: DescriptionTag): Map<String, String> =
        last.bindings + outputPrefixes(last.bindings).map { (canonical, prefix) -> prefix to NAMESPACES.getValue(canonical) }

    /** Restoring the loaded knots drops the change, so the saved bytes stay untouched. */
    fun withCurve(curve: PointCurve, knots: List<CurveKnot>): XmpDocument =
        XmpDocument(
            source,
            changes,
            if (knots == source.curves[curve].orEmpty()) curves - curve else curves + (curve to knots),
            masks,
        )

    fun withField(field: AdjustmentField, value: Float): XmpDocument {
        require(value.isFinite() && value in field.minimum..field.maximum)
        require(field.xmp.isNotEmpty()) { "No scalar XMP representation for ${field.name}" }
        val number = format(value)
        val additions = mapOf(field.xmp to if (number == format(field.initial)) null else number)
        val wb =
            if (field.name == "temperature" || field.name == "tint")
                mapOf(
                    field.xmp to number,
                    "crs:WhiteBalance" to "Custom",
                    "papp:WbScaleVersion" to AdjustmentFields.whiteBalanceScaleVersion.toString(),
                    "papp:WbSource" to "Manual",
                )
            else emptyMap()
        return XmpDocument(source, changes + additions + wb, curves, masks)
    }

    val rating: Int
        get() =
            attribute("xmp:Rating")
                ?.toDoubleOrNull()
                ?.takeIf { it.isFinite() && it in -1.0..5.0 && it == it.toInt().toDouble() }
                ?.toInt() ?: 0

    fun withAttribute(name: String, value: String?) =
        XmpDocument(source, changes + (name to value), curves, masks)

    fun withoutWhiteBalance(): XmpDocument =
        listOf(
                "crs:Temperature",
                "crs:Tint",
                "crs:WhiteBalance",
                "papp:WbSource",
                "papp:WbScaleVersion",
                "papp:WbAlgorithmVersion",
                "papp:WbSampleX",
                "papp:WbSampleY",
            )
            .fold(this) { document, key -> document.withAttribute(key, null) }

    fun resetFields(fields: List<AdjustmentField>): XmpDocument {
        val scalar =
            fields
                .filterNot { it.name == "temperature" || it.name == "tint" }
                .fold(this) { document, field -> document.withField(field, field.initial) }
        return if (fields.any { it.name == "temperature" || it.name == "tint" })
            scalar.withoutWhiteBalance()
        else scalar
    }

    fun withoutRawOnlySliders(): XmpDocument =
        AdjustmentFields.all
            .filter { !it.rasterSupported && it.xmp.isNotEmpty() }
            .fold(this) { doc, field -> doc.withField(field, field.initial) }

    fun attribute(name: String): String? {
        if (changes.containsKey(name)) return changes[name]
        return source.attributes[name]
    }

    fun serialize(): String {
        val tags = source.tags
        val profile =
            attribute("papp:Profile")
                ?: if (attribute("papp:Look") == "Neutral") "Neutral" else "Auto"
        val wbScale =
            attribute("papp:WbScaleVersion")
                ?: if (attribute("crs:Temperature") != null || attribute("crs:Tint") != null) {
                    val mapleAuthored = tags.any { (_, scope) ->
                        scope.bindings.values.any {
                            it == NAMESPACES.getValue("papp") || it in LEGACY_PAPP
                        }
                    }
                    if (mapleAuthored) "1" else AdjustmentFields.whiteBalanceScaleVersion.toString()
                } else null
        val owned =
            changes +
                mapOf(
                    "papp:Profile" to profile,
                    "papp:WbScaleVersion" to wbScale,
                    "crs:HasSettings" to "True",
                    "crs:Version" to (attribute("crs:Version") ?: "11.0"),
                    "crs:ProcessVersion" to (attribute("crs:ProcessVersion") ?: "11.0"),
                )
        val lastScope = tags.last().second
        val descriptionTags = source.descriptionTags
        val last = descriptionTags.last()
        val indent = childIndent(original, last)
        val maskEdits = masks?.let { edit ->
            source.maskContainers.mapIndexedNotNull { index, (child, description) ->
                val text = edit.containers[index]
                when {
                    text == originalMask(index) -> null
                    text.isEmpty() -> removal(original, child, description)
                    else -> XmlEdit(child.start, child.end, text)
                }
            }
        }.orEmpty()
        val block =
            pointCurveBlock(curves, last, outputPrefixes(lastScope.bindings), indent) +
                masks?.appended.orEmpty().joinToString("") { "\n$indent$it" }
        val (insertion, selfClosingTail) = appendToDescription(original, last, block)
        val curveEdits = pointCurveRemovals(original, descriptionTags, curves, ::attributeName) + maskEdits + insertion
        val replacements = tags.map { (tag, scope) ->
            val stripped =
                ATTRIBUTE.replace(tag.value) { match ->
                    when {
                        attributeName(match.groupValues[1], scope.bindings) in owned -> ""
                        match.groupValues[1] == "xmlns:papp" &&
                            scope.bindings["papp"] in LEGACY_PAPP ->
                            match.value.replace(match.groupValues[3], NAMESPACES.getValue("papp"))
                        else -> match.value
                    }
                }
            val suffix = if (stripped.endsWith("/>")) "/>" else ">"
            val extra =
                if (tag == tags.last().first)
                    buildString {
                        val prefixes = outputPrefixes(scope.bindings)
                        for ((canonical, uri) in NAMESPACES) {
                            val prefix = prefixes.getValue(canonical)
                            val declared = scope.bindings[prefix]
                            val local =
                                ATTRIBUTE.findAll(tag.value).any {
                                    it.groupValues[1] == "xmlns:$prefix"
                                }
                            if (declared == null || (declared in LEGACY_PAPP && !local))
                                append("\n      xmlns:$prefix=\"$uri\"")
                        }
                        owned.entries
                            .sortedWith(compareBy({ priority(it.key) }, { it.key }))
                            .forEach { (key, value) ->
                                val prefix = key.substringBefore(':')
                                val name =
                                    if (':' !in key) key
                                    else "${prefixes[prefix] ?: prefix}:${key.substringAfter(':')}"
                                if (value != null) append("\n      $name=\"${escape(value)}\"")
                            }
                    }
                else ""
            val closing = if (tag == tags.last().first && selfClosingTail.isNotEmpty()) ">$selfClosingTail" else suffix
            XmlEdit(tag.range.first, tag.range.last, stripped.dropLast(suffix.length) + extra + closing)
        }
        val edits = (replacements + curveEdits).sortedBy { it.start }
        val size = original.length + edits.sumOf { it.text.length - (it.end + 1 - it.start) }
        return buildString(size) {
                var cursor = 0
                for (edit in edits) {
                    append(original, cursor, edit.start)
                    append(edit.text)
                    cursor = edit.end + 1
                }
                append(original, cursor, original.length)
            }
            .also(::validate)
    }

    companion object {
        const val EMPTY =
            "<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" /></rdf:RDF></x:xmpmeta>\n<?xpacket end=\"w\"?>"
        private val ATTRIBUTE =
            Regex("""\s+([^\s=<>/'"?]+)\s*=\s*(['"])(.*?)\2""", RegexOption.DOT_MATCHES_ALL)
        private val LEGACY_PAPP = setOf("http://ns.justmaple.app/1.0/", "https://maple.app/ns/1.0/")
        /** Slice 1's JSON mask attribute: raw-core still reads it when no container models a layer. */
        private const val LEGACY_MASKS = "papp:LocalAdjustments"

        /** [bindings] as [serialize] leaves them: a local legacy `papp` declaration is rewritten. */
        private fun effectiveBindings(tag: String, bindings: Map<String, String>): Map<String, String> =
            if (bindings["papp"] in LEGACY_PAPP && ATTRIBUTE.findAll(tag).any { it.groupValues[1] == "xmlns:papp" })
                bindings + ("papp" to NAMESPACES.getValue("papp"))
            else bindings
        private val DESCRIPTION =
            Regex(
                "<!--.*?-->|<!\\[CDATA\\[.*?\\]\\]>|<\\?.*?\\?>|(<(?:[^\\s<>/!?=:\"']+:)?Description(?=[\\s/>])(?:[^>\"']|\"[^\"]*\"|'[^']*')*>)",
                RegexOption.DOT_MATCHES_ALL,
            )
        private val NAMESPACES =
            mapOf(
                "crs" to "http://ns.adobe.com/camera-raw-settings/1.0/",
                "papp" to "http://ns.justmaple.app/photo/1.0/",
                "xmp" to "http://ns.adobe.com/xap/1.0/",
            )

        private data class DescriptionScope(
            val bindings: Map<String, String>,
            val attributes: Map<String, String>,
            /** A direct child of the document's `rdf:RDF`. */
            val topLevel: Boolean,
            /** A top-level description of the primary subject: the only ones read and edited. */
            val primary: Boolean,
        )

        /** One top-level description's subject and score, as raw-core's `xmp::subject` ranks them. */
        private class SubjectCandidate(val subject: String, val tier: Int) {
            var score = 0
        }

        private fun outputPrefixes(bindings: Map<String, String>): Map<String, String> =
            NAMESPACES.mapValues { (canonical, uri) ->
                val declared = bindings[canonical]
                if (
                    declared == null ||
                        declared == uri ||
                        (canonical == "papp" && declared in LEGACY_PAPP)
                )
                    canonical
                else
                    bindings.entries.firstOrNull { it.value == uri }?.key
                        ?: generateSequence(0) { it + 1 }
                            .map { if (it == 0) "maple_$canonical" else "maple_${canonical}_$it" }
                            .first { it !in bindings }
            }

        private fun canonicalPrefix(uri: String?): String? =
            NAMESPACES.entries.firstOrNull { it.value == uri || (it.key == "papp" && uri in LEGACY_PAPP) }?.key

        private fun attributeName(name: String, scope: Map<String, String>): String {
            if (':' !in name) return name
            val prefix = name.substringBefore(':')
            val canonical = canonicalPrefix(scope[prefix])
            return if (canonical != null) "$canonical:${name.substringAfter(':')}"
            else if (prefix in NAMESPACES) "" else name
        }

        private fun descriptions(xml: String): List<Pair<MatchResult, DescriptionScope>> {
            val tags = DESCRIPTION.findAll(xml).filter { it.groupValues[1].isNotEmpty() }.toList()
            val scopes = descriptionBindings(xml)
            require(tags.size == scopes.size) { "Unsupported RDF description syntax" }
            return tags.zip(scopes)
        }

        /**
         * Every `Description` element in document order. Of the top-level ones only the
         * primary subject's are editable: raw-core ranks them by subject (`rdf:about=""`,
         * then anonymous, then any other `about` or `nodeID`) and then by how many develop
         * keys they carry, and ignores every other subject (#4690).
         */
        private fun descriptionBindings(xml: String): List<DescriptionScope> {
            val parser = Xml.newPullParser()
            parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true)
            parser.setInput(StringReader(xml.removePrefix("\uFEFF")))
            var rdfDepth: Int? = null
            var insideRdf = false
            val found = mutableListOf<DescriptionScope>()
            val candidates = mutableListOf<SubjectCandidate>()
            var open: SubjectCandidate? = null
            var openDepth = -1
            while (parser.next() != XmlPullParser.END_DOCUMENT) {
                if (
                    rdfDepth == null &&
                        parser.eventType == XmlPullParser.START_TAG &&
                        parser.name == "RDF" &&
                        parser.namespace == RDF_NAMESPACE
                ) {
                    rdfDepth = parser.depth
                    insideRdf = true
                }
                if (parser.eventType == XmlPullParser.END_TAG) {
                    if (parser.depth == rdfDepth) insideRdf = false
                    if (parser.depth == openDepth) open = null
                    continue
                }
                if (parser.eventType != XmlPullParser.START_TAG) continue
                open?.takeIf { parser.depth == openDepth + 1 }?.let { candidate ->
                    val prefix = canonicalPrefix(parser.namespace)
                    if (prefix != null && "$prefix:${parser.name}" in XmpSubject.containers) candidate.score += 1
                }
                if (parser.name != "Description") continue
                val bindings = buildMap {
                    for (i in 0 until parser.getNamespaceCount(parser.depth)) {
                        parser.getNamespacePrefix(i)?.let { put(it, parser.getNamespaceUri(i)) }
                    }
                }
                val attributes = buildMap {
                    for (i in 0 until parser.attributeCount) {
                        val prefix = parser.getAttributePrefix(i)
                        val local = parser.getAttributeName(i)
                        val qualified = if (prefix.isNullOrEmpty()) local else "$prefix:$local"
                        put(attributeName(qualified, bindings), parser.getAttributeValue(i))
                    }
                }
                val topLevel = insideRdf && parser.depth == rdfDepth?.plus(1) && parser.namespace == RDF_NAMESPACE
                if (topLevel) {
                    val candidate = subjectCandidate(parser, candidates.size)
                    candidate.score = attributes.keys.count { it in XmpSubject.attributes }
                    candidates += candidate
                    open = candidate
                    openDepth = parser.depth
                }
                found += DescriptionScope(bindings, attributes, topLevel, primary = false)
            }
            val primary =
                candidates.reduceOrNull { best, next ->
                    if (next.tier > best.tier || (next.tier == best.tier && next.score > best.score)) next else best
                }
            val eligible = candidates.map { it.subject == primary?.subject }.iterator()
            return found.map { if (it.topLevel) it.copy(primary = eligible.next()) else it }
        }

        private fun subjectCandidate(parser: XmlPullParser, index: Int): SubjectCandidate {
            var about: String? = null
            var nodeId: String? = null
            for (i in 0 until parser.attributeCount) {
                val namespace = parser.getAttributeNamespace(i).orEmpty()
                val rdf = namespace == RDF_NAMESPACE
                val unbound = namespace.isEmpty()
                when (parser.getAttributeName(i)) {
                    "about" -> if (rdf || (unbound && about == null)) about = parser.getAttributeValue(i)
                    "nodeID" -> if (rdf || (unbound && nodeId == null)) nodeId = parser.getAttributeValue(i)
                }
            }
            return when {
                about != null && nodeId == null -> SubjectCandidate("about:$about", if (about.isEmpty()) 2 else 0)
                about == null && nodeId == null -> SubjectCandidate("anonymous:$index", 1)
                about == null -> SubjectCandidate("node:$nodeId", 0)
                else -> SubjectCandidate("anonymous:$index", 0)
            }
        }

        private fun priority(name: String) =
            when (name.substringBefore(':')) {
                "xmp" -> 0
                "crs" -> 1
                "papp" -> 2
                else -> 500
            }

        fun format(value: Float) =
            String.format(Locale.ROOT, "%.2f", value).trimEnd('0').trimEnd('.').let {
                if (it == "-0") "0" else it
            }

        private fun escape(value: String) =
            value
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;")

        private fun validate(xml: String) {
            require(!xml.contains("<!DOCTYPE", ignoreCase = true)) { "DTD is not supported in XMP" }
            val parser = Xml.newPullParser()
            parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true)
            parser.setInput(StringReader(xml.removePrefix("\uFEFF")))
            while (parser.next() != XmlPullParser.END_DOCUMENT) {
                /* Validate the entire document. */
            }
        }
    }
}
